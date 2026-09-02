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
#     │     │     그 외          → _build_memo_brief()         (필터링 후 시간대별 샘플링)
#     │     └─ _call_gemma_category_insights() : Gemma Call 1 — 카테고리별 최대 4문장 분석
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
import time
from collections import defaultdict
from datetime import date, datetime, timedelta

from core.db import get_conn
from core.pii_mask import mask_phone_numbers
from core.holidays import is_off_day, previous_business_day
from core.gemma_client import call_gemma, parse_json_response
from core.audit_log import log_action
from core.prompt_settings import get_prompt_text
from core import report_progress
from features.issues.classifier import extract_symptom_fields
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
    "<date>{date_str}</date>\n"
    "<category>{cat_label}</category>\n"
    "<memos>\n{memos}\n</memos>"
)

# role/rules/example 구조 + few-shot 예시. 카테고리 나열 문장(순서·형식)은 Gemma한테 아무리
# "기타는 항상 마지막에" 같은 엄격한 규칙을 줘도 실제로는 절반 정도만 지켜졌다 — LLM 문장
# 생성에 100% 강제가 필요한 부분을 맡기면 안 된다는 걸 확인했다. 그래서 카테고리별 건수·순서
# 나열은 Python이 _format_category_listing()으로 직접 조립해 미리 만들어두고(항상 정확한
# 순서·형식 보장), Gemma한테는 "왜 그런지/영향"에 해당하는 reason 한두 문장만 맡긴다 —
# 숫자를 옮겨 적다 순서나 형식을 틀리는 실수 자체가 구조적으로 안 생기게 책임을 나눴다.
_SYSTEM_PEAK_BUCKET = (
    "<role>\n"
    "당신은 단비교육 공감센터의 CS 데이터 분석가입니다. 특정 시간대에 접수된 CS 상담 메모를 검토해서\n"
    "그 시간대에 특이한 패턴이 있는지 판단합니다. 카테고리별 건수·비율 나열은 이미 정확히 집계되어\n"
    "별도로 화면에 표시되므로, 당신은 그 수치를 반복하지 말고 reason에 '왜 그런지 또는 사용자에게\n"
    "어떤 영향인지'만 작성합니다.\n"
    "</role>\n\n"
    "<rules>\n"
    "- JSON 객체 하나만 출력합니다. 백틱(`)이나 마크다운 코드 블록으로 감싸지 않습니다.\n"
    "- reason은 1~2문장입니다. 카테고리 이름이나 건수·비율을 다시 나열하지 마세요 — 그건 이미\n"
    "  다른 곳에 정확히 표시되어 있습니다. 왜 이 시간에 몰렸을지 또는 사용자에게 어떤 영향인지만\n"
    "  씁니다.\n"
    "- 제공된 메모에 실제로 나타난 내용만 씁니다. 메모에 없는 새로운 사건이나 용어를 만들어내지\n"
    "  않습니다. 해석·판단이 들어가면 '~로 보입니다', '~가능성이 있습니다' 같은 추측 표현을\n"
    "  씁니다. 단정하지 않습니다.\n"
    "- pattern은 같은 유형의 문제가 반복될 때만 10자 이내 키워드로 씁니다(예: '기기 전원 꺼짐·배터리 방전').\n"
    "  특정 패턴이 없으면 빈 문자열로 둡니다.\n"
    "- CS 운영 조언은 쓰지 않습니다.\n"
    "- 카테고리 분포 아래 '→'로 시작하는 안내 문구가 있으면 그 지시를 그대로 따르세요. 특히\n"
    "  '없는 원인을 지어내지 말라'는 안내가 있으면, '특정 원인 없이 여러 카테고리가 고르게\n"
    "  접수된 시간대로 보입니다' 정도로 짧게만 쓰고 그럴듯한 이유를 상상해서 덧붙이지 마세요.\n"
    "</rules>\n\n"
    "<example>\n"
    "1위가 40% 이상이라는 안내가 있다면:\n"
    '{"pattern": "네트워크 연결 불안정", "reason": "이 시간대에 특정 지역·통신사 문의가 몰린 것으로 보입니다."}\n'
    "\n"
    "1위가 40% 미만이라 '원인을 지어내지 말라'는 안내가 있다면:\n"
    '{"pattern": "", "reason": "특정 원인 없이 다양한 문의가 골고루 몰린 시간대로 보입니다."}\n'
    "</example>\n\n"
    "위 예시와 같은 형식으로, JSON 객체 하나만 출력하세요."
)

_PROMPT_PEAK_BUCKET = (
    "<date>{date_str}</date>\n"
    "<time_range>피크타임(17~20시) 중 가장 많은 문의가 접수된 {bucket_start}~{bucket_end} 구간</time_range>\n"
    "<stats>이 구간 {bucket_count}건 / 피크타임 30분 평균 {avg_count}건</stats>\n"
    "{breakdown}"
)

# 피크타임(17~20시) 밖인데 그날 피크타임 최다 버킷보다 인입이 많은 버킷이 있을 때만 실행된다.
# 백필·이력 현행화로 CS 업무시간이 아닌 때 대량 유입될 경우를 포착하기 위함 (평소 패턴 지표인
# 피크타임 분석과는 별개로, 존재할 때만 추가되는 이상탐지형 분석). 시스템 프롬프트는 피크타임과 공용.
_PROMPT_ANOMALY_BUCKET = (
    "<date>{date_str}</date>\n"
    "<time_range>피크타임(17~20시)이 아닌데도 문의가 가장 많이 접수된 {bucket_start}~{bucket_end} 구간</time_range>\n"
    "<stats>이 구간 {bucket_count}건 / 같은 날 피크타임 최다 버킷 {peak_count}건</stats>\n"
    "{breakdown}"
)

# 피크타임 버킷 키 집합 (30분 단위, 17:00~20:00 마지막 버킷까지 — _fetch_day_stats의 기존 조건과 동일)
_PEAK_BUCKET_KEYS = {"17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00"}

# ── 내부 함수 ─────────────────────────────────────────────────────────────────


def _fetch_day_stats(date_str: str) -> dict:
    with get_conn() as conn:
        total = conn.execute(
            "SELECT COUNT(*) FROM cs_issues WHERE date(datetime(created_date, '+9 hours')) = ?",
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
            FROM cs_issues
            WHERE date(datetime(created_date, '+9 hours')) = ?
            """,
            (date_str,)
        ).fetchall()

        hourly_raw = conn.execute(
            """
            SELECT CAST(strftime('%H', datetime(created_date, '+9 hours')) AS INTEGER) as h,
                   COUNT(*) as cnt
            FROM cs_issues
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
            FROM cs_issues
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
            mask_phone_numbers(row["call_memo"]), row["hour"], row["minute"]
        )
        if main and sub and _is_risk(main, sub):
            main_sub_memos[main][sub].append({"id": id_, "text": memo or "", "hour": hour})
        bucket_min = 0 if minute < 30 else 30
        bucket_key = f"{hour}:{bucket_min:02d}"
        all_bucket_rows.setdefault(bucket_key, []).append({
            "id": id_, "text": memo or "", "main": main or "미분류", "sub": sub or "",
        })

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


# 시간대별 균형 샘플링에 쓰는 구간·상한. 필터링된 메모가 이 상한(100건)을 넘을 때만 적용된다.
# 예전엔 RULES 키워드로 메모를 그룹핑해서 가장 큰 그룹 1~2개만 프롬프트에 넣었는데, 실제로
# 돌려보니 카테고리에 따라 최대 73%가 어느 그룹에도 안 걸려서 그 메모들은 통계에도 프롬프트에도
# 아예 반영이 안 됐다. 키워드 매칭 정확도에 기대는 대신, 시간대 기준으로 골고루 뽑아서 특정
# 시간대(예: 가장 바쁜 오후)에 쏠리지 않게 한다.
_TIME_BUCKET_RANGES = {
    "아침": range(9, 13),   # 09~12시
    "오후": range(13, 18),  # 13~17시
    "저녁": range(18, 24),  # 18~23시
}
_TIME_BUCKET_CAPS = {"아침": 30, "오후": 30, "저녁": 40}
_MAX_MEMOS_WITHOUT_BUCKETING = 100


def _clean_memo_line(memo: dict) -> str | None:
    """메모 원문을 프롬프트용 한 줄로 정제. 20자 미만이면 의미 있는 내용이 없다고 보고 제외한다."""
    text = extract_symptom_fields(memo["text"])
    text = " ".join(text.split())[:150]
    return text if len(text) >= 20 else None


def _build_memo_brief(memos: list[dict], sub: str, clean_fn=_clean_memo_line) -> dict:
    """메모를 정제·필터링한 뒤, 건수가 많으면(100건 초과) 시간대(아침/오후/저녁)별로 나눠서
    균형 있게 샘플링한다. 필터링을 먼저 하고 시간대 분배를 나중에 해야 한다 — 순서를 바꾸면
    시간대별로 목표 건수만큼 뽑았는데 그중 상당수가 필터에 걸려 실제 반영 건수가 목표보다
    부족해지는 문제가 생긴다.
    반환: {"prompt_text": str, "groups": [{"sub": str, "count": int, "memos": []}]}"""
    filtered = []
    for m in memos:
        line = clean_fn(m)
        if line:
            filtered.append({"hour": m["hour"], "text": line})

    if len(filtered) <= _MAX_MEMOS_WITHOUT_BUCKETING:
        sampled = filtered
    else:
        buckets: dict[str, list] = {name: [] for name in _TIME_BUCKET_RANGES}
        for m in filtered:
            for name, hours in _TIME_BUCKET_RANGES.items():
                if m["hour"] in hours:
                    buckets[name].append(m)
                    break
        sampled = []
        for name, cap in _TIME_BUCKET_CAPS.items():
            sampled.extend(buckets[name][:cap])

    if not sampled:
        return {"prompt_text": "", "groups": []}

    # 문구가 완전히 같은 메모끼리 묶어서 (N건)을 붙인다 — Gemma가 "여러 건"을 인용할 때 쓸
    # 유일한 실제 숫자 출처다. 이게 없으면 Gemma가 메모를 읽고 스스로 사유별로 나눠 세는데,
    # 표본이 작을 땐(5~20건) 우연히 맞아떨어져도 표본이 커지면 틀릴 수 있다 — 숫자는
    # 여기서 실제로 집계된 것만 쓰게 한다(_SYSTEM_CATEGORY 규칙과 짝).
    text_counts: dict = {}
    text_order: list = []
    for m in sampled:
        text = m["text"]
        if text not in text_counts:
            text_counts[text] = 0
            text_order.append(text)
        text_counts[text] += 1

    lines = []
    for text in text_order:
        count = text_counts[text]
        suffix = f" ({count}건)" if count > 1 else ""
        lines.append(f"[{len(lines) + 1}] {text}{suffix}")
    prompt_text = f"# {sub} ({len(sampled)}건)\n" + "\n".join(lines)
    return {"prompt_text": prompt_text, "groups": [{"sub": sub, "count": len(sampled), "memos": []}]}


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


def _prepare_category_brief(risk_rows: list) -> None:
    """각 row에 analysis_groups·insufficient_data·_prompt_section 주입. 반환값 없음."""
    for row in risk_rows:
        if row["main"] == "해지·유지 상담":
            result = _build_cancellation_brief(row["memos"])
        else:
            result = _build_memo_brief(row["memos"], row["sub"])
        total = sum(g["count"] for g in result["groups"])
        row["analysis_groups"] = result["groups"]
        row["_top_category"] = result.get("top_category")
        row["insufficient_data"] = total < _MIN_ANALYSIS_MEMOS
        row["_analysis_count"] = total
        if not row["insufficient_data"]:
            row["_prompt_section"] = result["prompt_text"]


# ── Gemma 호출 ───────────────────────────────────────────────────────────────

_CITED_COUNT_RE = re.compile(r'(\d+)\s*건')


def _validate_cited_counts(summary: str, prompt_section: str) -> str | None:
    """summary에 나온 'N건' 숫자가 프롬프트에 실제로 제공된 숫자(dedup 건수·분포표·헤더 총건수)
    중 하나인지 검증한다. 프롬프트 규칙("제공된 숫자만 인용하라")을 지시만으로는 100% 지키게
    할 수 없다 — 실제로 (N건)이 하나도 안 붙은 날에도 Gemma가 그럴듯한 숫자를 지어낸 사례가
    있었다. 검증 실패 시 실패 사유 문자열을 돌려주고(호출부가 다른 실패와 동일하게 gemma_error로
    남겨 기존 재시도 루프(_MAX_RETRIES)를 그대로 타게 한다), 통과하면 None."""
    valid = {int(n) for n in _CITED_COUNT_RE.findall(prompt_section)}
    cited = {int(n) for n in _CITED_COUNT_RE.findall(summary)}
    invalid = cited - valid
    if invalid:
        invalid_str = ", ".join(f"{n}건" for n in sorted(invalid))
        valid_str = ", ".join(f"{n}건" for n in sorted(valid)) or "없음"
        return f"제공되지 않은 건수 인용: {invalid_str} (제공된 값: {valid_str})"
    return None


_FALLBACK_GROUP_PATTERNS = [
    re.compile(r'^\[\d+\]\s+(.+?)\s+\((\d+)건\)$'),  # 메모 dedup: "[1] 텍스트 (2건)"
    re.compile(r'^([^:\n]+):\s*(\d+)건'),              # 분포표: "충전·전원 불량: 22건 (11.3%)"
]
_FALLBACK_HEADER_TOTAL_RE = re.compile(r'^#.*?\((?:전체\s*)?(\d+)건')


def _build_fallback_summary(prompt_section: str) -> str:
    """Gemma가 없는 숫자를 반복해서 지어내 _MAX_RETRIES까지 검증에 계속 실패했을 때 쓰는
    최후 수단. LLM을 거치지 않고 prompt_section(실제로 제공했던 사유별 건수)만 그대로
    문장으로 조립한다 — 자연스러운 서술은 포기하는 대신 숫자는 무조건 정확하다. 화면에는
    "실패"라는 표현 없이 실제 집계 결과를 안내하는 톤으로 노출된다(내부 실패 여부는
    daily_report_fallback_summary 감사 로그로 추적)."""
    groups: list[tuple[str, int]] = []
    seen: set = set()
    for line in prompt_section.split("\n"):
        line = line.strip()
        for pattern in _FALLBACK_GROUP_PATTERNS:
            m = pattern.match(line)
            if m:
                label, cnt = m.group(1).strip(), int(m.group(2))
                if label not in seen:
                    seen.add(label)
                    groups.append((label, cnt))
                break

    if groups:
        groups.sort(key=lambda g: -g[1])
        parts = [f"{label} {cnt}건" for label, cnt in groups[:5]]
        return "실제 접수 건수를 그대로 집계했습니다: " + ", ".join(parts) + "."

    total_match = _FALLBACK_HEADER_TOTAL_RE.search(prompt_section)
    if total_match:
        return (
            f"이 사유로 총 {total_match.group(1)}건이 접수되었습니다. 사례마다 내용이 달라 "
            "세부 유형별 집계 대신 전체 건수만 안내합니다."
        )
    return "집계 가능한 데이터가 없어 요약을 생략합니다."


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
        # 화면 "▼ Gemma 프롬프트 보기"에 그대로 노출되는 필드. 실패 원인을 눈으로 확인하려면
        # 실제로 무엇을 보냈는지(시스템 지시문 포함) 봐야 해서, 요약용 _prompt_section과
        # 별도로 시스템+유저 프롬프트 전문을 합쳐 저장한다.
        system_prompt = get_prompt_text("daily_category", _SYSTEM_CATEGORY)
        row["_full_prompt"] = f"[SYSTEM]\n{system_prompt}\n\n[USER]\n{prompt}"

        print(f"[Gemma Daily Cat - {cat_label}] 프롬프트 길이: {len(prompt)}자\n{'-'*60}\n{prompt}\n{'-'*60}")
        _start = time.time()
        try:
            raw = await call_gemma(system_prompt, prompt)
            row["_elapsed"] = round(time.time() - _start, 1)
            result = parse_json_response(raw)
            if result and result.get("summary"):
                invalid_reason = _validate_cited_counts(result["summary"], row.get("_prompt_section", ""))
                if invalid_reason:
                    row["summary"] = ""
                    row["gemma_error"] = invalid_reason
                    print(f"[Gemma Daily Cat - {cat_label}] {invalid_reason}")
                else:
                    row["summary"] = result["summary"]
                    row["gemma_error"] = None
            else:
                row["summary"] = ""
                row["gemma_error"] = describe_gemma_failure(raw)
                print(f"[Gemma Daily Cat - {cat_label}] {row['gemma_error']}")
        except Exception as e:
            row["_elapsed"] = round(time.time() - _start, 1)
            row["summary"] = ""
            row["gemma_error"] = str(e)
            print(f"[Gemma Daily Cat - {cat_label}] 실패 (건너뜀): {e}")


def _bucket_end(bucket_key: str) -> str:
    h, m = map(int, bucket_key.split(':'))
    end_h, end_m = (h, 30) if m == 0 else (h + 1, 0)
    return f"{end_h}:{end_m:02d}"


_BUCKET_EXAMPLES_PER_CATEGORY = 5
_BUCKET_MAX_EXAMPLES = 30
# 1위 카테고리가 이 비율 이상이면 "뚜렷한 원인이 있다"고 보고 구체적으로 짚으라고 지시한다.
# 미만이면 여러 카테고리가 고르게 섞인 것이므로, 없는 원인을 억지로 만들어내지 말라고 지시한다
# — 실제로 8/19 14:30 버킷(1위가 26.6%뿐)에서 뚜렷한 원인 없이도 Gemma가 그럴듯한 이유를
# 지어낼 뻔한 사례가 있었다.
_DOMINANT_CATEGORY_THRESHOLD = 0.4


def _format_category_listing(sorted_mains: list[tuple[str, int]], total: int) -> str:
    """카테고리 나열 문장을 Python이 직접 조립한다. Gemma한테 "기타는 항상 마지막에
    언급하라"고 규칙으로 못박아도 실제로는 절반 정도만 지켜졌다 — 순서·형식을 엄격히
    지켜야 하는 부분은 LLM 문장 생성에 맡기지 않고 코드가 직접 만들어야 100% 보장된다.
    '순으로'는 항목별 조사(이/가) 없이도 자연스러워서 받침 유무를 신경 쓸 필요가 없다."""
    parts = [f"{name} {cnt}건({round(cnt / total * 100, 1)}%)" for name, cnt in sorted_mains]
    return ", ".join(parts) + " 순으로 접수되었습니다."


def _build_bucket_brief(memos: list[dict]) -> dict:
    """30분 버킷 안에 섞인 여러 카테고리의 정확한 건수 분포를 먼저 보여주고, 카테고리별로
    대표 예시를 몇 건씩 뽑아 붙인다. 예전엔 뒤섞인 메모를 그냥 앞에서부터 30건 잘라서
    보냈는데, 그러면 우연히 한 카테고리가 앞쪽에 몰려 있을 때 그 카테고리만 있는 것처럼
    편향되게 보이고, 카테고리 구성 자체를 Gemma가 텍스트만 보고 추측해야 했다.
    반환: {"text": str, "top_category": {"name", "count", "pct"} | None, "listing": str}"""
    total = len(memos)
    counts: dict[str, int] = {}
    by_main: dict[str, list] = {}
    for m in memos:
        counts[m["main"]] = counts.get(m["main"], 0) + 1
        by_main.setdefault(m["main"], []).append(m)

    # "기타"는 건수가 아무리 많아도 실체가 없는 잔여 분류라, 1위로 잡히면 Gemma가 "기타가
    # 가장 많다"는 의미 없는 문장을 만들거나 없는 원인을 지어낼 위험이 있다. 정렬 자체에서
    # 항상 맨 뒤로 보내 — 목록에도 마지막에 나오고, 1위(top_category)로도 절대 안 뽑히게 한다.
    sorted_mains = sorted(counts.items(), key=lambda kv: (kv[0] == "기타", -kv[1]))
    dist_lines = [f"{main}: {cnt}건 ({round(cnt / total * 100, 1)}%)" for main, cnt in sorted_mains]
    top_main, top_count = sorted_mains[0]
    top_pct = top_count / total
    if top_pct >= _DOMINANT_CATEGORY_THRESHOLD:
        guidance = (
            f"→ 1위 카테고리('{top_main}')가 전체의 {round(top_pct * 100, 1)}%로 뚜렷하게 많습니다. "
            "요약 마지막 문장에서 왜 이 카테고리가 몰렸을지 아래 예시 메모 내용에 근거해 구체적으로 언급하세요."
        )
    else:
        guidance = (
            "→ 특정 카테고리가 40% 이상을 차지하지 않았습니다. 없는 원인을 지어내지 말고, "
            "여러 카테고리가 고르게 섞여 있다는 사실만 요약하세요."
        )
    dist_section = f"# 카테고리 분포 (전체 {total}건, 정확히 집계된 수치)\n" + "\n".join(dist_lines) + "\n" + guidance

    example_lines = []
    for main, _ in sorted_mains:
        per_main = 0
        for m in by_main[main]:
            text = extract_symptom_fields(m["text"])
            text = " ".join(text.split())[:150]
            if len(text) >= 20:
                example_lines.append(f"[{len(example_lines) + 1}] ({main}) {text}")
                per_main += 1
            if per_main >= _BUCKET_EXAMPLES_PER_CATEGORY or len(example_lines) >= _BUCKET_MAX_EXAMPLES:
                break
        if len(example_lines) >= _BUCKET_MAX_EXAMPLES:
            break

    sections = [dist_section]
    if example_lines:
        sections.append("# 대표 예시\n" + "\n".join(example_lines))

    top_category = {"name": top_main, "count": top_count, "pct": round(top_pct * 100, 1)}
    listing = _format_category_listing(sorted_mains, total)
    return {"text": "\n\n".join(sections), "top_category": top_category, "listing": listing}


async def _run_bucket_gemma(label: str, prompt: str, base: dict) -> dict:
    """버킷 분석 공통 실행부: Gemma 호출 → 파싱 → base에 결과/gemma_error 채워 반환.
    호출 자체가 있었는데 실패한 경우엔 gemma_error를 채운다 (빈 dict로 뭉개면 "애초에
    분석 대상이 없었던 것"과 "분석했는데 실패한 것"을 구분할 수 없기 때문)."""
    system_prompt = get_prompt_text("daily_peak", _SYSTEM_PEAK_BUCKET)
    print(f"[Gemma Daily {label}] 프롬프트 길이: {len(prompt)}자\n{'-'*60}\n{prompt}\n{'-'*60}")
    full_prompt = f"[SYSTEM]\n{system_prompt}\n\n[USER]\n{prompt}"
    start = time.time()
    try:
        raw = await call_gemma(system_prompt, prompt)
        elapsed = round(time.time() - start, 1)
        result = parse_json_response(raw)
    except Exception as e:
        elapsed = round(time.time() - start, 1)
        print(f"[Gemma Daily {label}] 실패 (건너뜀): {e}")
        return {**base, "gemma_error": str(e), "elapsed": elapsed, "gemma_prompt": full_prompt}

    if not result:
        return {**base, "gemma_error": describe_gemma_failure(raw), "elapsed": elapsed, "gemma_prompt": full_prompt}

    pattern = result.get("pattern", "")
    reason = result.get("reason", "")
    # 카테고리 나열 문장(순서·형식 100% 고정)은 base["listing"]으로 미리 조립해 넘어와 있다.
    # Gemma는 그 뒤에 붙는 "왜/영향" 한두 문장(reason)만 작성 — 숫자를 다시 베껴 쓰다 순서를
    # 틀리는 실수 자체가 안 생기게 책임을 나눴다.
    summary = f"{base.get('listing', '')} {reason}".strip()
    return {
        **base,
        "pattern": pattern,
        "summary": summary,
        "has_pattern": bool(pattern),
        "gemma_error": None,
        "elapsed": elapsed,
        "gemma_prompt": full_prompt,
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

    brief = _build_bucket_brief(memos)
    if not brief["text"]:
        return {}

    base = {
        "bucket_start": max_bucket, "bucket_end": bucket_end,
        "bucket_count": bucket_count, "avg_count": avg_count,
        "pattern": "", "summary": "", "has_pattern": False,
        "top_category": brief["top_category"],
        "listing": brief["listing"],
    }
    prompt = _PROMPT_PEAK_BUCKET.format(
        date_str=date_str,
        bucket_start=max_bucket,
        bucket_end=bucket_end,
        bucket_count=bucket_count,
        avg_count=avg_count,
        breakdown=brief["text"],
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

    brief = _build_bucket_brief(memos)
    if not brief["text"]:
        return {}

    base = {
        "bucket_start": anomaly_key, "bucket_end": bucket_end,
        "bucket_count": bucket_count, "peak_count": peak_max_count,
        "pattern": "", "summary": "", "has_pattern": False,
        "top_category": brief["top_category"],
        "listing": brief["listing"],
    }
    prompt = _PROMPT_ANOMALY_BUCKET.format(
        date_str=date_str,
        bucket_start=anomaly_key,
        bucket_end=bucket_end,
        bucket_count=bucket_count,
        peak_count=peak_max_count,
        breakdown=brief["text"],
    )
    return await _run_bucket_gemma(f"Anomaly {anomaly_key}~{bucket_end}", prompt, base)

# ── 공개 API ──────────────────────────────────────────────────────────────────


def _build_content(date_str: str, stats: dict, peak_bucket: dict, anomaly_bucket: dict | None = None) -> dict:
    prev_date = previous_business_day(date_str)
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
                "gemma_prompt": r.get("_full_prompt", ""),
                "prompt_section": r.get("_prompt_section", ""),
                "elapsed": r.get("_elapsed"),
                "top_category": r.get("_top_category"),
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
                r["gemma_prompt"] = row.get("_full_prompt", "")
                r["elapsed"] = row.get("_elapsed")
                r["top_category"] = row.get("_top_category")
                break
        _save_report(date_str, existing)

    return {
        "main": row["main"],
        "sub": row["sub"],
        "count": row["count"],
        "summary": row.get("summary", ""),
        "insufficient_data": row.get("insufficient_data", False),
        "analysis_count": row.get("_analysis_count"),
        "gemma_error": row.get("gemma_error"),
        "gemma_prompt": row.get("_full_prompt", ""),
        "elapsed": row.get("_elapsed"),
        "top_category": row.get("_top_category"),
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
                r["gemma_prompt"] = rr.get("_full_prompt", "")
                r["prompt_section"] = rr.get("_prompt_section", "")
                r["elapsed"] = rr.get("_elapsed")
                r["top_category"] = rr.get("_top_category")

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

        # _MAX_RETRIES를 다 써도 여전히 실패한 카테고리 카드에는, 화면에 아무것도 안 보여주는
        # 대신 실제 제공했던 데이터만으로 조립한 문장을 채워 넣는다(코드 조립이라 숫자는
        # 무조건 정확하다). gemma_error는 지워서 화면에 정상 카드처럼 뜨게 하고, 문장도 "실패"
        # 대신 "실제 건수를 그대로 안내한다"는 톤으로 쓴다 — 실패 여부는 화면이 아니라
        # daily_report_fallback_summary 감사 로그로만 추적한다.
        fallback_used = []
        for row in content.get("risk_rows", []):
            if row.get("gemma_error"):
                row["summary"] = _build_fallback_summary(row.get("prompt_section", ""))
                row["gemma_error"] = None
                fallback_used.append(row["main"])
        if fallback_used:
            _save_report(date_str, content)
            log_action(
                "daily_report_fallback_summary",
                f"date={date_str}, mains={','.join(fallback_used)}",
                mode=mode,
            )
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


def get_latest_report() -> dict | None:
    """가장 최근 저장된 일별 보고서 조회. 없으면 None.
    페이지 첫 진입 시 기본 날짜를 고를 때 쓴다 — "어제"로 고정하면 주말·공휴일 다음 날이나
    수집/생성이 밀린 날엔 정작 보고서가 없는 날짜로 들어가게 된다."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT content, generated_at FROM reports WHERE report_type = 'daily' ORDER BY report_date DESC LIMIT 1",
        ).fetchone()
    if not row:
        return None
    result = json.loads(row["content"])
    result["generated_at"] = row["generated_at"]
    return result
