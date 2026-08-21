# -*- coding: utf-8 -*-
# 일별 CS 보고서 생성 모듈. DB 쿼리로 당일 통계를 뽑고 Gemma를 순차 호출해 인사이트를 생성한다.
#
# 주요 흐름:
#   generate_report_stats(date_str) → 통계만 저장 (Gemma 없음, 빠른 첫 렌더링)
#   generate_report(date_str)       → 통계 + Gemma 분석 전체 저장
#     ├─ _fetch_day_stats()               : DB → 총건수, 리스크 5개, 시간대별 건수, 피크 버킷 row
#     ├─ _prepare_category_brief()        : 카테고리별 Gemma용 텍스트 생성
#     │     해지·유지 상담 → _build_cancellation_brief() (해지 사유 카운팅)
#     │     그 외          → _build_keyword_groups()     (RULES 키워드 그룹핑)
#     ├─ _call_gemma_category_insights() : Gemma Call 1 — 카테고리별 2줄 분석
#     ├─ _call_gemma_peak_bucket()       : Gemma Call 2 — 피크 최다 버킷 분석
#     └─ reports 테이블 UPSERT (report_type='daily') → 결과 반환
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
from features.issues.classifier import extract_symptom_fields, RULES, SUB_TO_MAIN
from features.report.report_utils import (
    INSUFFICIENT_SUMMARY, _MIN_ANALYSIS_MEMOS,
    _MAIN_ORDER, _is_risk, _SYSTEM_CATEGORY,
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

_SYSTEM_PEAK_BUCKET = (
    "당신은 단비교육 공감센터 CS 분석 전문가입니다.\n"
    "CS팀 운영이 아닌 개발·서비스 품질 관점에서 분석하세요.\n"
    "규칙: 코드 블록 없이 JSON만 출력\n"
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
    peak_bucket_rows: dict = {}

    for row in rows:
        id_, main, sub, memo, hour, minute = (
            row["id"], row["new_category_main"], row["new_category_sub"],
            row["call_memo"], row["hour"], row["minute"]
        )
        if main and sub and _is_risk(main, sub):
            main_sub_memos[main][sub].append({"id": id_, "text": memo or ""})
        if hour in {17, 18, 19} or (hour == 20 and minute < 30):
            bucket_min = 0 if minute < 30 else 30
            bucket_key = f"{hour}:{bucket_min:02d}"
            if bucket_key not in peak_bucket_rows:
                peak_bucket_rows[bucket_key] = []
            peak_bucket_rows[bucket_key].append({"id": id_, "text": memo or ""})

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
                row["gemma_error"] = "Gemma 응답 파싱 실패 또는 빈 응답"
                print(f"[Gemma Daily Cat - {cat_label}] {row['gemma_error']}")
        except Exception as e:
            row["summary"] = ""
            row["gemma_error"] = str(e)
            print(f"[Gemma Daily Cat - {cat_label}] 실패 (건너뜀): {e}")


async def _call_gemma_peak_bucket(date_str: str, peak_bucket_rows: dict) -> dict:
    """Call 2: 피크타임 최다 버킷 메모 → Gemma 분석. 데이터 없으면 빈 dict 반환.
    Gemma 호출 자체가 있었는데 실패한 경우엔 gemma_error를 채워서 반환한다 (빈 dict로
    뭉개면 "애초에 분석 대상이 없었던 것"과 "분석했는데 실패한 것"을 구분할 수 없기 때문)."""
    if not peak_bucket_rows:
        return {}

    max_bucket = max(peak_bucket_rows, key=lambda k: len(peak_bucket_rows[k]))
    memos = peak_bucket_rows[max_bucket]
    bucket_count = len(memos)

    total_peak = sum(len(v) for v in peak_bucket_rows.values())
    avg_count = round(total_peak / len(peak_bucket_rows), 1)

    h, m = map(int, max_bucket.split(':'))
    end_h, end_m = (h, 30) if m == 0 else (h + 1, 0)
    bucket_end = f"{end_h}:{end_m:02d}"

    lines = []
    for memo in memos:
        text = extract_symptom_fields(memo["text"])
        text = " ".join(text.split())[:150]
        if len(text) >= 20:
            lines.append(f"[{len(lines)+1}] {text}")
        if len(lines) >= 30:
            break

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
    print(f"[Gemma Daily Peak {max_bucket}~{bucket_end}] 프롬프트 길이: {len(prompt)}자\n{'-'*60}\n{prompt}\n{'-'*60}")
    try:
        raw = await call_gemma(_SYSTEM_PEAK_BUCKET, prompt)
        result = parse_json_response(raw)
    except Exception as e:
        print(f"[Gemma Daily Peak {max_bucket}~{bucket_end}] 실패 (건너뜀): {e}")
        return {**base, "gemma_error": str(e)}

    if not result:
        return {**base, "gemma_error": "Gemma 응답 파싱 실패 또는 빈 응답"}

    pattern = result.get("pattern", "")
    return {
        **base,
        "pattern": pattern,
        "summary": result.get("summary", ""),
        "has_pattern": bool(pattern),
        "gemma_error": None,
    }

# ── 공개 API ──────────────────────────────────────────────────────────────────


def _build_content(date_str: str, stats: dict, peak_bucket: dict) -> dict:
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


async def generate_report(date_str: str) -> dict:
    """통계 + Gemma AI 분석 전체 생성 → DB 저장 → 결과 반환."""
    stats = _fetch_day_stats(date_str)
    await _call_gemma_category_insights(date_str, stats["risk_rows"])
    peak_bucket = await _call_gemma_peak_bucket(date_str, stats["peak_bucket_rows"])
    content = _build_content(date_str, stats, peak_bucket)
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
    """피크타임 최다 버킷만 Gemma 분석 실행. 저장하지 않고 결과만 반환. 테스트용."""
    stats = _fetch_day_stats(date_str)
    peak_bucket_rows = stats["peak_bucket_rows"]
    if not peak_bucket_rows:
        return {"error": "피크타임 데이터 없음"}

    max_bucket = max(peak_bucket_rows, key=lambda k: len(peak_bucket_rows[k]))
    memos = peak_bucket_rows[max_bucket]
    bucket_count = len(memos)

    total_peak = sum(len(v) for v in peak_bucket_rows.values())
    avg_count = round(total_peak / len(peak_bucket_rows), 1)

    h, m = map(int, max_bucket.split(':'))
    end_h, end_m = (h, 30) if m == 0 else (h + 1, 0)
    bucket_end = f"{end_h}:{end_m:02d}"

    lines = []
    for memo in memos:
        text = extract_symptom_fields(memo["text"])
        text = " ".join(text.split())[:150]
        if len(text) >= 20:
            lines.append(f"[{len(lines)+1}] {text}")
        if len(lines) >= 30:
            break

    prompt = _PROMPT_PEAK_BUCKET.format(
        date_str=date_str,
        bucket_start=max_bucket,
        bucket_end=bucket_end,
        bucket_count=bucket_count,
        avg_count=avg_count,
        memos="\n".join(lines),
    )

    print(f"[Gemma Peak Test {max_bucket}~{bucket_end}] 프롬프트 길이: {len(prompt)}자\n{'-'*60}\n{prompt}\n{'-'*60}")
    result_pattern = ""
    result_summary = ""
    gemma_error = None
    insufficient = len(lines) < 3
    if not insufficient:
        try:
            raw = await call_gemma(_SYSTEM_PEAK_BUCKET, prompt)
            parsed = parse_json_response(raw)
            if parsed and parsed.get("summary"):
                result_pattern = parsed.get("pattern", "")
                result_summary = parsed["summary"]
            else:
                gemma_error = "Gemma 응답 파싱 실패 또는 빈 응답"
        except Exception as e:
            gemma_error = str(e)
            print(f"[Gemma Peak Test] 실패: {e}")

    result = {
        "bucket_start": max_bucket,
        "bucket_end": bucket_end,
        "bucket_count": bucket_count,
        "avg_count": avg_count,
        "pattern": result_pattern,
        "summary": result_summary,
        "has_pattern": bool(result_pattern),
        "insufficient_data": insufficient,
        "gemma_error": gemma_error,
        "prompt_section": prompt if lines else "",
    }

    if not insufficient and result_summary:
        existing = get_report(date_str)
        if existing:
            existing["peak_bucket"] = {k: v for k, v in result.items() if k != "prompt_section" and k != "insufficient_data"}
            _save_report(date_str, existing)

    return result


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
