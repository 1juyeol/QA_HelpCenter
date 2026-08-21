# -*- coding: utf-8 -*-
# 일별 CS 보고서 생성 모듈. DB 쿼리로 당일 통계를 뽑고 Gemma를 순차 호출해 인사이트를 생성한다.
#
# 주요 흐름:
#   generate_report_stats(date_str) → 통계만 저장 (Gemma 없음, 빠른 첫 렌더링)
#   generate_report_full(date_str, mode) → 통계 → 카테고리별 → 피크타임 → 이상시간대 →
#     실패 항목 재시도까지 전부 실행하는 단일 생성 로직. scheduler.py의 새벽 배치(mode='auto')와
#     '재생성' 버튼(POST /api/report/daily/generate, mode='manual')이 트리거만 다르고 이 함수
#     하나를 그대로 공유한다. 단계마다:
#     ├─ _fetch_day_stats()               : DB → 총건수, 리스크 5개, 시간대별 건수, 피크 버킷 row
#     ├─ analyze_single_category()        : 카테고리 하나 Gemma 분석 + 즉시 저장 (반복)
#     │     ├─ _prepare_category_brief()  : 카테고리별 Gemma용 텍스트 생성
#     │     │     해지·유지 상담 → _build_cancellation_brief() (해지 사유 카운팅)
#     │     │     그 외          → _build_keyword_groups()     (RULES 키워드 그룹핑)
#     │     └─ _call_gemma_category_insights() : Gemma Call 1 — 카테고리별 2줄 분석
#     ├─ analyze_peak_bucket()            : 피크타임(17~20시) 최다 버킷 분석 + 즉시 저장
#     ├─ analyze_anomaly_bucket()         : 피크타임 밖인데 그보다 인입이 많은 버킷이 있을 때만
#     │                                    실행 (백필 등 이상 유입 포착) + 즉시 저장
#     └─ retry_failed_analyses()          : gemma_error 남은 항목만 대기 없이 즉시 재시도, 최대 2회
#   각 단계 진행 상태는 core/report_progress.py에 기록해 새로고침해도 "지금 몇 번째 단계"인지
#   알 수 있게 하고(예전엔 브라우저 탭 메모리에만 있어서 새로고침하면 유실됐다), 단계별 결과는
#   감사 로그(daily_report_analyze_category/peak/anomaly, daily_report_retry_failed)에 남긴다.
#
# has_gemma_failures(content) / retry_failed_analyses(date_str, content):
#   gemma_error가 남은 항목만 다시 시도하는 재시도용 함수. generate_report_full()이 쓴다.
#
# 공유 상수·유틸: report_utils.py (RISK_MAIN, _is_risk, _SYSTEM_CATEGORY 등)
# Gemma 클라이언트: core/gemma_client.py
# 정책 2 준수: DB 날짜 필터는 datetime(created_date, '+9 hours') KST 변환

import json
import re
from collections import defaultdict
from datetime import date, datetime, timedelta

from core.db import get_conn
from core.holidays import is_off_day
from core.gemma_client import call_gemma, parse_json_response
from core.audit_log import log_action
from core import report_progress
from features.issues.classifier import extract_symptom_fields, RULES, SUB_TO_MAIN
from features.report.report_utils import (
    INSUFFICIENT_SUMMARY, _MIN_ANALYSIS_MEMOS,
    _MAIN_ORDER, _is_risk, _SYSTEM_CATEGORY, describe_gemma_failure, gemma_detail,
)

# "해지요청사유 :아이흥미없음" 또는 "해지사유 콘텐츠불만" 형태에서 사유 추출
_CANCEL_REASON_RE = re.compile(r'해지(?:요청)?사유\s*[: ]\s*(\S+)')
# N차 상담 fallback: "-해지확정 아이흥미없음" 형태
_CANCEL_REASON_FALLBACK_RE = re.compile(r'해지확정\s+([가-힣()\-_·]+)')

# ── Gemma 프롬프트 (일별 전용) ───────────────────────────────────────────────

_PROMPT_CATEGORY = (
    "아래는 {date_str} [{cat_label}] CS 상담 메모입니다.\n"
    "메모에서 반복되는 현상을 두 문장으로 분석하세요.\n"
    "첫 문장: 어떤 현상이 반복되는지.\n"
    "두 번째 문장: 그 현상이 사용자에게 어떤 영향을 주는지 또는 왜 심각한지.\n"
    "건수 단순 반복('N건 접수')이나 CS 운영 조언은 쓰지 마세요.\n\n"
    "{memos}"
)

# "코드 블록 없이 JSON만 출력"이라는 문구가 오히려 모델이 코드 펜스(```)를 열어야 한다는
# 신호로 헷갈려서 여는 기호 3글자만 뱉고 끝내버리는 사례가 있었다 — "백틱을 쓰지 말라"고
# 더 직접적으로 지시해서 이 실패를 줄여보려는 시도.
_SYSTEM_PEAK_BUCKET = (
    "당신은 단비교육 공감센터 CS 분석 전문가입니다.\n"
    "CS팀 운영이 아닌 개발·서비스 품질 관점에서 분석하세요.\n"
    "규칙: 백틱(`)을 절대 쓰지 마세요. 마크다운 코드 블록으로 감싸지 말고 JSON 객체만 그대로 출력하세요.\n"
    '응답 형식:\n{"pattern": "반복 패턴 키워드. 없으면 빈 문자열.", "summary": "두 문장 분석. 항상 작성."}'
)

_PROMPT_PEAK_BUCKET = (
    "아래는 {date_str} 피크타임(17~20시) 중 가장 많은 문의가 접수된\n"
    "{bucket_start}~{bucket_end} 구간의 CS 상담 메모입니다.\n"
    "이 구간에 {bucket_count}건이 접수됐으며, 피크타임 30분 평균은 {avg_count}건입니다.\n"
    "\n"
    "메모를 읽고 이 시간대에 특이한 패턴이 있는지 판단하세요.\n"
    "summary는 항상 두 문장으로 작성하세요.\n"
    "  첫 문장: 이 시간대에 어떤 현상·증상이 접수됐는지.\n"
    "  두 번째 문장: 왜 이 시간에 집중됐을 가능성 또는 사용자 영향.\n"
    "pattern: 같은 유형의 문제가 반복된다면 10자 이내 키워드 (예: '기기 전원 꺼짐·배터리 방전'). 특정 패턴이 없으면 빈 문자열.\n"
    "건수 단순 반복('N건 접수됐습니다')이나 CS 운영 조언은 쓰지 마세요.\n\n"
    "{memos}"
)

# 피크타임(17~20시) 밖인데 그날 피크타임 최다 버킷보다 인입이 많은 버킷이 있을 때만 실행된다.
# 백필·이력 현행화로 CS 업무시간이 아닌 때 대량 유입될 경우를 포착하기 위함 (평소 패턴 지표인
# 피크타임 분석과는 별개로, 존재할 때만 추가되는 이상탐지형 분석).
_PROMPT_ANOMALY_BUCKET = (
    "아래는 {date_str}에 피크타임(17~20시)이 아닌데도 오히려 문의가 가장 많이 접수된\n"
    "{bucket_start}~{bucket_end} 구간의 CS 상담 메모입니다.\n"
    "이 구간에 {bucket_count}건이 접수됐으며, 같은 날 피크타임 최다 버킷({peak_count}건)보다 많습니다.\n"
    "\n"
    "메모를 읽고 이 시간대에 특이한 패턴이 있는지, 왜 피크타임이 아닌데 몰렸는지 판단하세요.\n"
    "summary는 항상 두 문장으로 작성하세요.\n"
    "  첫 문장: 이 시간대에 어떤 현상·증상이 접수됐는지.\n"
    "  두 번째 문장: 왜 이 시간에 집중됐을 가능성 또는 사용자 영향 (예: 이력 일괄 정리, 특정 이벤트 등).\n"
    "pattern: 같은 유형의 문제가 반복된다면 10자 이내 키워드. 특정 패턴이 없으면 빈 문자열.\n"
    "건수 단순 반복('N건 접수됐습니다')이나 CS 운영 조언은 쓰지 마세요.\n\n"
    "{memos}"
)

# 피크타임 버킷 키 집합 (30분 단위, 17:00~20:00 마지막 버킷까지 — _fetch_day_stats의 기존 조건과 동일)
_PEAK_BUCKET_KEYS = {"17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00"}

# ── 내부 함수 ─────────────────────────────────────────────────────────────────


def _fetch_day_stats(date_str: str) -> dict:
    with get_conn() as conn:
        total = conn.execute(
            "SELECT COUNT(*) FROM issues WHERE date(datetime(created_date, '+9 hours')) = ?",
            (date_str,)
        ).fetchone()[0]

        rows = conn.execute(
            """
            SELECT id,
                   new_category_main,
                   new_category_sub,
                   call_memo,
                   CAST(strftime('%H', datetime(created_date, '+9 hours')) AS INTEGER) as hour,
                   CAST(strftime('%M', datetime(created_date, '+9 hours')) AS INTEGER) as minute
            FROM issues
            WHERE date(datetime(created_date, '+9 hours')) = ?
            """,
            (date_str,)
        ).fetchall()

        hourly_raw = conn.execute(
            """
            SELECT CAST(strftime('%H', datetime(created_date, '+9 hours')) AS INTEGER) as h,
                   COUNT(*) as cnt
            FROM issues
            WHERE date(datetime(created_date, '+9 hours')) = ?
            GROUP BY h
            """,
            (date_str,)
        ).fetchall()

        d_report = date.fromisoformat(date_str)
        hist_off_days = [
            str(d_report - timedelta(days=i))
            for i in range(1, 29)
            if is_off_day(str(d_report - timedelta(days=i)))
        ]
        hist_off_clause = f"AND date(datetime(created_date, '+9 hours')) NOT IN ({','.join('?' for _ in hist_off_days)})" if hist_off_days else ""
        hist_rows = conn.execute(
            f"""
            SELECT date(datetime(created_date, '+9 hours')) as d, COUNT(*) as cnt
            FROM issues
            WHERE CAST(strftime('%H', datetime(created_date, '+9 hours')) AS INTEGER) BETWEEN 17 AND 20
              AND date(datetime(created_date, '+9 hours')) != ?
              AND date(datetime(created_date, '+9 hours')) >= date(?, '-28 days')
              {hist_off_clause}
            GROUP BY d
            """,
            (date_str, date_str, *hist_off_days)
        ).fetchall()

    hourly_map = {h: cnt for h, cnt in hourly_raw}
    hourly = [(h, hourly_map.get(h, 0)) for h in range(24)]

    hist_counts = [r["cnt"] for r in hist_rows]
    hist_peak = round(sum(hist_counts) / len(hist_counts), 1) if hist_counts else 0.0

    main_sub_memos: dict = defaultdict(lambda: defaultdict(list))
    all_bucket_rows: dict = {}

    for row in rows:
        id_, main, sub, memo, hour, minute = (
            row["id"], row["new_category_main"], row["new_category_sub"],
            row["call_memo"], row["hour"], row["minute"]
        )
        if main and sub and _is_risk(main, sub):
            main_sub_memos[main][sub].append({"id": id_, "text": memo or ""})
        bucket_min = 0 if minute < 30 else 30
        bucket_key = f"{hour}:{bucket_min:02d}"
        all_bucket_rows.setdefault(bucket_key, []).append({"id": id_, "text": memo or ""})

    peak_bucket_rows = {k: v for k, v in all_bucket_rows.items() if k in _PEAK_BUCKET_KEYS}

    risk_rows = []
    for main in _MAIN_ORDER:
        if main not in main_sub_memos:
            continue
        subs = main_sub_memos[main]
        sorted_subs = sorted(subs.items(), key=lambda kv: -len(kv[1]))
        top_sub, top_memos = sorted_subs[0]
        main_total = sum(len(ms) for ms in subs.values())
        risk_rows.append({
            "main": main,
            "sub": top_sub,
            "count": len(top_memos),
            "main_total": main_total,
            "memos": top_memos,
            "summary": "",
            "subs": [{"sub": s, "count": len(ms), "memos": ms} for s, ms in sorted_subs],
        })

    risk_total = sum(
        1 for row in rows
        if row["new_category_main"] and row["new_category_sub"]
        and _is_risk(row["new_category_main"], row["new_category_sub"])
    )

    return {
        "total_count": total,
        "risk_rows": risk_rows,
        "risk_total": risk_total,
        "hourly": hourly,
        "peak_bucket_rows": peak_bucket_rows,
        "all_bucket_rows": all_bucket_rows,
        "hist_peak": hist_peak,
    }


def _build_keyword_groups(memos: list[dict], main_cat: str, current_sub: str, max_groups: int) -> dict:
    """RULES 키워드로 메모를 그룹핑. SUB_TO_MAIN으로 현재 대분류의 관련 소분류만 탐색.
    반환: {"prompt_text": str, "groups": [{"sub": str, "count": int, "memos": [...]}]}"""
    relevant_subs = {sub for sub, main in SUB_TO_MAIN.items() if main == main_cat}
    relevant_rules = [(sub, kws) for sub, kws in RULES if sub in relevant_subs and sub != current_sub]

    rule_memo_map: dict[str, list] = {sub: [] for sub, _ in relevant_rules}
    for m in memos:
        for sub, keywords in relevant_rules:
            if any(kw in m["text"] for kw in keywords):
                rule_memo_map[sub].append(m)

    top_groups = sorted(
        [(sub, ms) for sub, ms in rule_memo_map.items() if ms],
        key=lambda x: -len(x[1]),
    )[:max_groups]

    seen_ids: set = set()
    prompt_sections = []
    result_groups = []

    for sub, matched_memos in top_groups:
        lines = []
        group_memos = []
        for m in matched_memos[:30]:
            if m["id"] in seen_ids:
                continue
            text = extract_symptom_fields(m["text"])
            text = " ".join(text.split())[:150]
            if len(text) >= 20:
                lines.append(f"[{len(lines)+1}] {text}")
                group_memos.append({"id": m["id"], "text": text})
                seen_ids.add(m["id"])
        if group_memos:
            prompt_sections.append(f"# {sub} ({len(group_memos)}건)\n" + "\n".join(lines))
            result_groups.append({"sub": sub, "count": len(group_memos), "memos": group_memos})

    return {"prompt_text": "\n\n".join(prompt_sections), "groups": result_groups}


def _build_cancellation_brief(memos: list[dict]) -> dict:
    """해지 확정 메모에서 해지 사유를 카운팅해 프롬프트 텍스트 생성.
    RULES 키워드 매칭 대신 사용. '해지요청사유 :X' / '해지사유 X' 패턴 추출."""
    counts: dict[str, int] = {}
    for m in memos:
        text = m.get("text", "")
        match = _CANCEL_REASON_RE.search(text) or _CANCEL_REASON_FALLBACK_RE.search(text)
        if match:
            reason = match.group(1).strip(".,")
            counts[reason] = counts.get(reason, 0) + 1

    sorted_reasons = sorted(counts.items(), key=lambda x: -x[1])
    total = sum(c for _, c in sorted_reasons)

    dist_lines = [f"{reason}: {cnt}건" for reason, cnt in sorted_reasons]
    dist_section = f"# 해지 사유 분포 ({total}건)\n" + "\n".join(dist_lines)

    # 각 사유별 대표 메모 1건씩, 최대 5건
    seen_reasons: set = set()
    sample_lines = []
    for m in memos:
        text = m.get("text", "")
        match = _CANCEL_REASON_RE.search(text) or _CANCEL_REASON_FALLBACK_RE.search(text)
        if not match:
            continue
        reason = match.group(1).strip(".,")
        if reason in seen_reasons:
            continue
        seen_reasons.add(reason)
        text = extract_symptom_fields(m["text"])
        text = " ".join(text.split())[:150]
        if len(text) >= 20:
            sample_lines.append(f"[{len(sample_lines)+1}] {text}")
        if len(sample_lines) >= 5:
            break

    sample_section = "# 메모 샘플\n" + "\n".join(sample_lines) if sample_lines else ""
    prompt_text = dist_section + ("\n\n" + sample_section if sample_section else "")

    groups = [{"sub": reason, "count": cnt, "memos": []} for reason, cnt in sorted_reasons]
    return {"prompt_text": prompt_text, "groups": groups}


def _build_raw_memo_brief(memos: list[dict], sub: str, max_memos: int = 20) -> dict:
    """키워드 그룹핑 결과가 부족할 때 폴백. 전처리 후 메모 원문을 직접 전송용 텍스트로 변환."""
    lines = []
    for m in memos[:max_memos]:
        text = extract_symptom_fields(m["text"])
        text = " ".join(text.split())[:150]
        if len(text) >= 20:
            lines.append(f"[{len(lines)+1}] {text}")
    if not lines:
        return {"prompt_text": "", "groups": []}
    prompt_text = f"# {sub} ({len(lines)}건)\n" + "\n".join(lines)
    groups = [{"sub": sub, "count": len(lines), "memos": []}]
    return {"prompt_text": prompt_text, "groups": groups}


def _prepare_category_brief(risk_rows: list) -> None:
    """각 row에 analysis_groups·insufficient_data·_prompt_section 주입. 반환값 없음."""
    for row in risk_rows:
        if row["main"] == "해지·유지 상담":
            result = _build_cancellation_brief(row["memos"])
        else:
            max_groups = 1 if row["count"] >= 50 else 2
            result = _build_keyword_groups(row["memos"], row["main"], row["sub"], max_groups)
            if sum(g["count"] for g in result["groups"]) < _MIN_ANALYSIS_MEMOS:
                result = _build_raw_memo_brief(row["memos"], row["sub"])
        total = sum(g["count"] for g in result["groups"])
        row["analysis_groups"] = result["groups"]
        row["insufficient_data"] = total < _MIN_ANALYSIS_MEMOS
        if not row["insufficient_data"]:
            row["_prompt_section"] = result["prompt_text"]


# ── Gemma 호출 ───────────────────────────────────────────────────────────────


async def _call_gemma_category_insights(date_str: str, risk_rows: list) -> None:
    """Call 1: 카테고리별로 Gemma를 개별 호출. 배치 호출 시 JSON 잘림 방지.
    각 row에 gemma_error를 남긴다: 성공/데이터부족이면 None, 실패면 실패 사유 문자열.
    예전엔 실패해도 print()로만 남고 사라졌는데, 이제 보고서 데이터 자체에 저장돼
    감사 로그·화면에서 "몇 번 실패했는지 왜 실패했는지" 추적 가능하다."""
    _prepare_category_brief(risk_rows)

    for row in risk_rows:
        if row.get("insufficient_data"):
            row["summary"] = INSUFFICIENT_SUMMARY
            row["gemma_error"] = None
            continue

        cat_label = f"{row['main']} > {row['sub']}"
        prompt = _PROMPT_CATEGORY.format(
            date_str=date_str,
            cat_label=cat_label,
            memos=row.get("_prompt_section", ""),
        )

        print(f"[Gemma Daily Cat - {cat_label}] 프롬프트 길이: {len(prompt)}자\n{'-'*60}\n{prompt}\n{'-'*60}")
        try:
            raw = await call_gemma(_SYSTEM_CATEGORY, prompt)
            result = parse_json_response(raw)
            if result and result.get("summary"):
                row["summary"] = result["summary"]
                row["gemma_error"] = None
            else:
                row["summary"] = ""
                row["gemma_error"] = describe_gemma_failure(raw)
                print(f"[Gemma Daily Cat - {cat_label}] {row['gemma_error']}")
        except Exception as e:
            row["summary"] = ""
            row["gemma_error"] = str(e)
            print(f"[Gemma Daily Cat - {cat_label}] 실패 (건너뜀): {e}")


def _bucket_end(bucket_key: str) -> str:
    h, m = map(int, bucket_key.split(':'))
    end_h, end_m = (h, 30) if m == 0 else (h + 1, 0)
    return f"{end_h}:{end_m:02d}"


def _build_bucket_lines(memos: list[dict]) -> list[str]:
    """버킷 메모를 Gemma 프롬프트용 번호 매긴 텍스트 라인으로 변환. 최대 30개."""
    lines = []
    for memo in memos:
        text = extract_symptom_fields(memo["text"])
        text = " ".join(text.split())[:150]
        if len(text) >= 20:
            lines.append(f"[{len(lines)+1}] {text}")
        if len(lines) >= 30:
            break
    return lines


async def _run_bucket_gemma(label: str, prompt: str, base: dict) -> dict:
    """버킷 분석 공통 실행부: Gemma 호출 → 파싱 → base에 결과/gemma_error 채워 반환.
    호출 자체가 있었는데 실패한 경우엔 gemma_error를 채운다 (빈 dict로 뭉개면 "애초에
    분석 대상이 없었던 것"과 "분석했는데 실패한 것"을 구분할 수 없기 때문)."""
    print(f"[Gemma Daily {label}] 프롬프트 길이: {len(prompt)}자\n{'-'*60}\n{prompt}\n{'-'*60}")
    try:
        raw = await call_gemma(_SYSTEM_PEAK_BUCKET, prompt)
        result = parse_json_response(raw)
    except Exception as e:
        print(f"[Gemma Daily {label}] 실패 (건너뜀): {e}")
        return {**base, "gemma_error": str(e)}

    if not result:
        return {**base, "gemma_error": describe_gemma_failure(raw)}

    pattern = result.get("pattern", "")
    return {
        **base,
        "pattern": pattern,
        "summary": result.get("summary", ""),
        "has_pattern": bool(pattern),
        "gemma_error": None,
    }


async def _call_gemma_peak_bucket(date_str: str, peak_bucket_rows: dict) -> dict:
    """Call 2: 피크타임 최다 버킷 메모 → Gemma 분석. 데이터 없으면 빈 dict 반환."""
    if not peak_bucket_rows:
        return {}

    max_bucket = max(peak_bucket_rows, key=lambda k: len(peak_bucket_rows[k]))
    memos = peak_bucket_rows[max_bucket]
    bucket_count = len(memos)

    total_peak = sum(len(v) for v in peak_bucket_rows.values())
    avg_count = round(total_peak / len(peak_bucket_rows), 1)
    bucket_end = _bucket_end(max_bucket)

    lines = _build_bucket_lines(memos)
    if not lines:
        return {}

    base = {
        "bucket_start": max_bucket, "bucket_end": bucket_end,
        "bucket_count": bucket_count, "avg_count": avg_count,
        "pattern": "", "summary": "", "has_pattern": False,
    }
    prompt = _PROMPT_PEAK_BUCKET.format(
        date_str=date_str,
        bucket_start=max_bucket,
        bucket_end=bucket_end,
        bucket_count=bucket_count,
        avg_count=avg_count,
        memos="\n".join(lines),
    )
    return await _run_bucket_gemma(f"Peak {max_bucket}~{bucket_end}", prompt, base)


def find_anomaly_bucket(all_bucket_rows: dict, peak_max_count: int) -> str | None:
    """피크타임(17~20시) 밖에서 건수가 피크타임 최다 버킷보다 많은 버킷이 있으면 그 키를 반환.
    여러 개면 가장 많은 것 하나만. 없으면 None. 백필·이력 현행화로 업무시간 외에 대량
    유입되는 경우를 잡기 위함 — 임계값(배수 등) 없이 "피크타임보다 많다"만 기준으로 한다."""
    off_peak = {k: v for k, v in all_bucket_rows.items() if k not in _PEAK_BUCKET_KEYS}
    if not off_peak:
        return None
    max_key = max(off_peak, key=lambda k: len(off_peak[k]))
    if len(off_peak[max_key]) > peak_max_count:
        return max_key
    return None


async def _call_gemma_anomaly_bucket(date_str: str, all_bucket_rows: dict, peak_bucket_rows: dict) -> dict:
    """Call 3: 피크타임 밖인데 피크타임보다 인입이 많은 버킷이 있으면 그것도 분석.
    해당 조건을 만족하는 버킷이 없으면 빈 dict (매일 실행되는 게 아니라 이상 시일 때만)."""
    peak_max_count = max((len(v) for v in peak_bucket_rows.values()), default=0)
    anomaly_key = find_anomaly_bucket(all_bucket_rows, peak_max_count)
    if anomaly_key is None:
        return {}

    memos = all_bucket_rows[anomaly_key]
    bucket_count = len(memos)
    bucket_end = _bucket_end(anomaly_key)

    lines = _build_bucket_lines(memos)
    if not lines:
        return {}

    base = {
        "bucket_start": anomaly_key, "bucket_end": bucket_end,
        "bucket_count": bucket_count, "peak_count": peak_max_count,
        "pattern": "", "summary": "", "has_pattern": False,
    }
    prompt = _PROMPT_ANOMALY_BUCKET.format(
        date_str=date_str,
        bucket_start=anomaly_key,
        bucket_end=bucket_end,
        bucket_count=bucket_count,
        peak_count=peak_max_count,
        memos="\n".join(lines),
    )
    return await _run_bucket_gemma(f"Anomaly {anomaly_key}~{bucket_end}", prompt, base)

# ── 공개 API ──────────────────────────────────────────────────────────────────


def _build_content(date_str: str, stats: dict, peak_bucket: dict, anomaly_bucket: dict | None = None) -> dict:
    from datetime import date as _date, timedelta as _td
    prev_date = str(_date.fromisoformat(date_str) - _td(days=1))
    prev = get_report(prev_date)
    return {
        "report_date": date_str,
        "total_count": stats["total_count"],
        "risk_total": stats["risk_total"],
        "prev_total_count": prev["total_count"] if prev else None,
        "prev_risk_total": prev["risk_total"] if prev else None,
        "risk_rows": [
            {
                "main": r["main"],
                "sub": r["sub"],
                "count": r["count"],
                "main_total": r.get("main_total", r["count"]),
                "subs": r.get("subs", []),
                "summary": r.get("summary", ""),
                "memos": r.get("memos", []),
                "analysis_groups": r.get("analysis_groups", []),
                "insufficient_data": r.get("insufficient_data", False),
                "gemma_error": r.get("gemma_error"),
            }
            for r in stats["risk_rows"]
        ],
        "peak_bucket": peak_bucket or None,
        "anomaly_bucket": anomaly_bucket or None,
        "hourly": stats["hourly"],
    }


def _save_report(date_str: str, content: dict) -> str:
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO reports (report_date, report_type, content, generated_at) "
            "VALUES (?, 'daily', ?, ?)",
            (date_str, json.dumps(content, ensure_ascii=False), generated_at),
        )
        conn.commit()
    return generated_at


async def generate_report_stats(date_str: str) -> dict:
    """통계만 저장 (Gemma 없음). 프론트엔드 첫 렌더링을 위한 1단계 생성."""
    stats = _fetch_day_stats(date_str)
    content = _build_content(date_str, stats, {})
    generated_at = _save_report(date_str, content)
    content["generated_at"] = generated_at
    return content


async def analyze_single_category(date_str: str, main_category: str) -> dict:
    """특정 대분류만 Gemma 분석 실행. 기존 보고서가 있으면 해당 카테고리 summary를 패치 저장."""
    stats = _fetch_day_stats(date_str)
    target_rows = [r for r in stats["risk_rows"] if r["main"] == main_category]
    if not target_rows:
        return {"error": f"'{main_category}' 카테고리 없음"}
    await _call_gemma_category_insights(date_str, target_rows)
    row = target_rows[0]

    existing = get_report(date_str)
    if existing:
        for r in existing["risk_rows"]:
            if r["main"] == main_category:
                r["summary"] = row.get("summary", "")
                r["analysis_groups"] = row.get("analysis_groups", [])
                r["insufficient_data"] = row.get("insufficient_data", False)
                r["gemma_error"] = row.get("gemma_error")
                break
        _save_report(date_str, existing)

    return {
        "main": row["main"],
        "sub": row["sub"],
        "count": row["count"],
        "summary": row.get("summary", ""),
        "insufficient_data": row.get("insufficient_data", False),
        "gemma_error": row.get("gemma_error"),
        "prompt_section": row.get("_prompt_section", ""),
    }


async def analyze_peak_bucket(date_str: str) -> dict:
    """피크타임 최다 버킷만 Gemma 분석 실행 (자동 생성과 동일한 _call_gemma_peak_bucket 사용).
    기존 보고서가 있으면 peak_bucket을 패치 저장한다. 예전엔 별도 로직으로 중복 구현되어 있었고
    성공했을 때만 저장해서 실패가 조용히 사라지는 버그가 있었다 — analyze_single_category처럼
    성공/실패 상관없이 항상 저장하도록 고쳤다."""
    stats = _fetch_day_stats(date_str)
    result = await _call_gemma_peak_bucket(date_str, stats["peak_bucket_rows"])

    existing = get_report(date_str)
    if existing:
        existing["peak_bucket"] = result or None
        _save_report(date_str, existing)

    return result


async def analyze_anomaly_bucket(date_str: str) -> dict:
    """이상시간대(피크타임 밖인데 그보다 인입이 많은 버킷) Gemma 분석 실행. 기존 보고서가
    있으면 anomaly_bucket을 패치 저장한다. analyze_peak_bucket()과 같은 방식."""
    stats = _fetch_day_stats(date_str)
    result = await _call_gemma_anomaly_bucket(date_str, stats["all_bucket_rows"], stats["peak_bucket_rows"])

    existing = get_report(date_str)
    if existing:
        existing["anomaly_bucket"] = result or None
        _save_report(date_str, existing)

    return result


def has_gemma_failures(content: dict) -> bool:
    """저장된 보고서 content에 gemma_error가 남아있는 항목이 하나라도 있으면 True."""
    if any(r.get("gemma_error") for r in content.get("risk_rows", [])):
        return True
    if content.get("peak_bucket") and content["peak_bucket"].get("gemma_error"):
        return True
    if content.get("anomaly_bucket") and content["anomaly_bucket"].get("gemma_error"):
        return True
    return False


def collect_gemma_failures(content: dict) -> list[str]:
    """저장된 보고서 content에서 gemma_error가 남은 항목들의 이름 목록(카테고리명/"피크타임"/
    "이상시간대")을 반환한다. 감사 로그 detail에 어떤 항목이 실패했는지 남기는 데 쓴다."""
    failed = [r["main"] for r in content.get("risk_rows", []) if r.get("gemma_error")]
    if content.get("peak_bucket") and content["peak_bucket"].get("gemma_error"):
        failed.append("피크타임")
    if content.get("anomaly_bucket") and content["anomaly_bucket"].get("gemma_error"):
        failed.append("이상시간대")
    return failed


def collect_gemma_failure_reasons(content: dict) -> list[str]:
    """collect_gemma_failures()와 같은 대상을 훑되, 이름이 아니라 "이름: 실패 사유"를 반환한다.
    감사 로그에서 "실패 항목: 기기·하드웨어 오류"만 보고는 왜 실패했는지 알 수 없어서,
    재시도·최종 완료 로그에는 실제 gemma_error 내용까지 같이 남긴다."""
    reasons = [
        f"{r['main']}: {r['gemma_error']}"
        for r in content.get("risk_rows", []) if r.get("gemma_error")
    ]
    if content.get("peak_bucket") and content["peak_bucket"].get("gemma_error"):
        reasons.append(f"피크타임: {content['peak_bucket']['gemma_error']}")
    if content.get("anomaly_bucket") and content["anomaly_bucket"].get("gemma_error"):
        reasons.append(f"이상시간대: {content['anomaly_bucket']['gemma_error']}")
    return reasons


async def retry_failed_analyses(date_str: str, content: dict) -> dict:
    """content에서 gemma_error가 남은 항목만 다시 시도해 갱신·저장한다. 재시도할 게 없으면
    그대로 반환. generate_report_full()이 매 재시도 라운드마다 이 함수를 호출한다."""
    stats = None

    failed_mains = {r["main"] for r in content.get("risk_rows", []) if r.get("gemma_error")}
    if failed_mains:
        stats = _fetch_day_stats(date_str)
        retry_rows = [r for r in stats["risk_rows"] if r["main"] in failed_mains]
        await _call_gemma_category_insights(date_str, retry_rows)
        retry_by_main = {r["main"]: r for r in retry_rows}
        for r in content["risk_rows"]:
            rr = retry_by_main.get(r["main"])
            if rr:
                r["summary"] = rr.get("summary", "")
                r["gemma_error"] = rr.get("gemma_error")
                r["analysis_groups"] = rr.get("analysis_groups", [])
                r["insufficient_data"] = rr.get("insufficient_data", False)

    if content.get("peak_bucket") and content["peak_bucket"].get("gemma_error"):
        stats = stats or _fetch_day_stats(date_str)
        content["peak_bucket"] = await _call_gemma_peak_bucket(date_str, stats["peak_bucket_rows"]) or content["peak_bucket"]

    if content.get("anomaly_bucket") and content["anomaly_bucket"].get("gemma_error"):
        stats = stats or _fetch_day_stats(date_str)
        content["anomaly_bucket"] = await _call_gemma_anomaly_bucket(
            date_str, stats["all_bucket_rows"], stats["peak_bucket_rows"]
        ) or content["anomaly_bucket"]

    _save_report(date_str, content)
    return content


_MAX_RETRIES = 2


async def generate_report_full(date_str: str, mode: str = "manual") -> dict:
    """통계 저장 → 카테고리별 개별 분석(단계마다 즉시 저장) → 피크타임 → 이상시간대 →
    실패 항목 재시도(대기 없이 즉시, 최대 _MAX_RETRIES회) 순서로 보고서를 생성하는 단일 로직.
    자동(스케줄러의 새벽 배치)과 수동('재생성' 버튼)이 트리거만 다를 뿐 이 함수 하나를 그대로
    공유한다 — 예전엔 자동은 한 번에 전체 호출 후 끝에 한 번만 저장(중간에 멈추면 이미 끝난
    것까지 전부 유실), 수동은 프론트엔드 반복문으로 카테고리를 하나씩 호출하는 별개 구현이라
    이상시간대 분석이 자동에만 있는 등 기능이 어긋났었다. 단계마다 report_progress에 진행 상태를
    남겨서 브라우저를 새로고침해도 "몇 번째 카테고리 진행 중"인지 알 수 있게 하고, 단계별
    결과는 감사 로그에 남긴다(mode로 auto/manual만 구분)."""
    stats = await generate_report_stats(date_str)
    risk_rows = stats["risk_rows"]
    total_steps = len(risk_rows) + 2  # 카테고리들 + 피크타임 + 이상시간대

    report_progress.start("daily", date_str, total_steps)
    try:
        for i, row in enumerate(risk_rows, start=1):
            report_progress.update("daily", date_str, row["main"], i)
            result = await analyze_single_category(date_str, row["main"])
            log_action(
                "daily_report_analyze_category",
                gemma_detail(f"date={date_str}, main={row['main']}", result),
                mode=mode,
            )

        report_progress.update("daily", date_str, "피크타임", len(risk_rows) + 1)
        peak_result = await analyze_peak_bucket(date_str)
        log_action("daily_report_analyze_peak", gemma_detail(f"date={date_str}", peak_result), mode=mode)

        report_progress.update("daily", date_str, "이상시간대", len(risk_rows) + 2)
        anomaly_result = await analyze_anomaly_bucket(date_str)
        log_action("daily_report_analyze_anomaly", gemma_detail(f"date={date_str}", anomaly_result), mode=mode)

        content = get_report(date_str)
        attempt = 0
        while has_gemma_failures(content) and attempt < _MAX_RETRIES:
            attempt += 1
            before_failed = set(collect_gemma_failures(content))
            report_progress.update("daily", date_str, f"실패 항목 재시도 {attempt}/{_MAX_RETRIES}", total_steps)
            content = await retry_failed_analyses(date_str, content)
            after_failed = set(collect_gemma_failures(content))
            resolved = before_failed - after_failed
            detail = f"date={date_str}, attempt={attempt}/{_MAX_RETRIES}"
            if resolved:
                detail += f", resolved={','.join(resolved)}"
            if after_failed:
                detail += f", gemma_failed={','.join(after_failed)}"
                reasons = collect_gemma_failure_reasons(content)
                if reasons:
                    detail += f", error={' / '.join(reasons)}"
            else:
                detail += ", status=success"
            log_action("daily_report_retry_failed", detail, mode=mode)
    finally:
        report_progress.finish("daily", date_str)

    failed = collect_gemma_failures(content)
    detail = f"date={date_str}"
    if failed:
        detail += f", gemma_failed={','.join(failed)}, status=partial_failure"
        reasons = collect_gemma_failure_reasons(content)
        if reasons:
            detail += f", error={' / '.join(reasons)}"
    else:
        detail += ", status=success"
    log_action("daily_report_generate_complete", detail, mode=mode)
    return content


def get_report(date_str: str) -> dict | None:
    """저장된 일별 보고서 조회. 없으면 None."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT content, generated_at FROM reports WHERE report_date = ? AND report_type = 'daily'",
            (date_str,)
        ).fetchone()
    if not row:
        return None
    result = json.loads(row["content"])
    result["generated_at"] = row["generated_at"]
    return result
