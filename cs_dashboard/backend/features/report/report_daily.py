# -*- coding: utf-8 -*-
# 일별 CS 보고서 생성 모듈. DB 쿼리로 당일 통계를 뽑고 Ollama를 순차 호출해 인사이트를 생성한다.
#
# 주요 흐름:
#   generate_report_stats(date_str) → 통계만 저장 (Ollama 없음, 빠른 첫 렌더링)
#   generate_report(date_str)       → 통계 + Ollama 분석 전체 저장
#     ├─ _fetch_day_stats()               : DB → 총건수, 리스크 5개, 시간대별 건수, 피크 버킷 row
#     ├─ _prepare_category_brief()        : RULES 키워드 그룹핑 + 150자 절삭 → Ollama용 텍스트
#     ├─ _call_ollama_category_insights() : Ollama Call 1 — 카테고리별 2줄 분석
#     ├─ _call_ollama_peak_bucket()       : Ollama Call 2 — 피크 최다 버킷 분석
#     └─ reports 테이블 UPSERT (report_type='daily') → 결과 반환
#
# 공유 상수·유틸: report_utils.py (RISK_MAIN, _is_risk, _SYSTEM_CATEGORY 등)
# Ollama 클라이언트: core/ollama_client.py
# 정책 2 준수: DB 날짜 필터는 datetime(created_date, '+9 hours') KST 변환

import json
from collections import defaultdict
from datetime import datetime

from core.db import get_conn
from core.ollama_client import call_ollama, parse_json_response
from features.issues.classifier import extract_symptom_fields, RULES, SUB_TO_MAIN
from features.report.report_utils import (
    INSUFFICIENT_SUMMARY, _MIN_ANALYSIS_MEMOS,
    _MAIN_ORDER, _is_risk, _SYSTEM_CATEGORY,
)

# ── Ollama 프롬프트 (일별 전용) ───────────────────────────────────────────────

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
    '응답 형식:\n{"summary": "두 문장 분석.", "has_pattern": true}'
)

_PROMPT_PEAK_BUCKET = (
    "아래는 {date_str} 피크타임(17~20시) 중 가장 많은 문의가 접수된\n"
    "{bucket_start}~{bucket_end} 구간의 CS 상담 메모입니다.\n"
    "이 구간에 {bucket_count}건이 접수됐으며, 피크타임 30분 평균은 {avg_count}건입니다.\n"
    "\n"
    "메모를 읽고 이 시간대에 특이한 패턴이 있는지 판단하세요.\n"
    "패턴이 있다면 두 문장으로 분석하세요.\n"
    "첫 문장: 어떤 현상·증상이 반복됐는지.\n"
    "두 번째 문장: 왜 이 시간에 집중됐을 가능성이 있는지, 또는 사용자에게 어떤 영향을 주는지.\n"
    "패턴이 없다면 summary는 빈 문자열로 두고 has_pattern을 false로 반환하세요.\n"
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

        hist_rows = conn.execute(
            """
            SELECT date(datetime(created_date, '+9 hours')) as d, COUNT(*) as cnt
            FROM issues
            WHERE CAST(strftime('%H', datetime(created_date, '+9 hours')) AS INTEGER) BETWEEN 17 AND 20
              AND date(datetime(created_date, '+9 hours')) != ?
              AND date(datetime(created_date, '+9 hours')) >= date(?, '-28 days')
            GROUP BY d
            """,
            (date_str, date_str)
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
        top_sub = max(subs, key=lambda s: len(subs[s]))
        memos = subs[top_sub]
        main_total = sum(len(ms) for ms in subs.values())
        risk_rows.append({
            "main": main,
            "sub": top_sub,
            "count": len(memos),
            "main_total": main_total,
            "memos": memos,
            "summary": "",
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


def _prepare_category_brief(risk_rows: list) -> None:
    """각 row에 analysis_groups·insufficient_data·_prompt_section 주입. 반환값 없음."""
    for row in risk_rows:
        max_groups = 1 if row["count"] >= 50 else 2
        result = _build_keyword_groups(row["memos"], row["main"], row["sub"], max_groups)
        total = sum(g["count"] for g in result["groups"])
        row["analysis_groups"] = result["groups"]
        row["insufficient_data"] = total < _MIN_ANALYSIS_MEMOS
        if not row["insufficient_data"]:
            row["_prompt_section"] = result["prompt_text"]


# ── Ollama 호출 ───────────────────────────────────────────────────────────────


async def _call_ollama_category_insights(date_str: str, risk_rows: list) -> None:
    """Call 1: 카테고리별로 Ollama를 개별 호출. 배치 호출 시 JSON 잘림 방지."""
    _prepare_category_brief(risk_rows)

    for row in risk_rows:
        if row.get("insufficient_data"):
            row["summary"] = INSUFFICIENT_SUMMARY
            continue

        cat_label = f"{row['main']} > {row['sub']}"
        prompt = _PROMPT_CATEGORY.format(
            date_str=date_str,
            cat_label=cat_label,
            memos=row.get("_prompt_section", ""),
        )

        print(f"[Ollama Daily Cat - {cat_label}] 프롬프트 길이: {len(prompt)}자\n{'-'*60}\n{prompt}\n{'-'*60}")
        try:
            raw = await call_ollama(_SYSTEM_CATEGORY, prompt)
            result = parse_json_response(raw)
            row["summary"] = result.get("summary", "") if result else ""
        except Exception as e:
            print(f"[Ollama Daily Cat - {cat_label}] 실패 (건너뜀): {e}")
            row["summary"] = ""


async def _call_ollama_peak_bucket(date_str: str, peak_bucket_rows: dict) -> dict:
    """Call 2: 피크타임 최다 버킷 메모 → Ollama 분석. 데이터 없으면 빈 dict 반환."""
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
    for memo in memos[:40]:
        text = extract_symptom_fields(memo["text"])
        text = " ".join(text.split())[:150]
        if len(text) >= 20:
            lines.append(f"[{len(lines)+1}] {text}")

    if not lines:
        return {}

    prompt = _PROMPT_PEAK_BUCKET.format(
        date_str=date_str,
        bucket_start=max_bucket,
        bucket_end=bucket_end,
        bucket_count=bucket_count,
        avg_count=avg_count,
        memos="\n".join(lines),
    )
    print(f"[Ollama Daily Peak {max_bucket}~{bucket_end}] 프롬프트 길이: {len(prompt)}자")
    try:
        raw = await call_ollama(_SYSTEM_PEAK_BUCKET, prompt)
        result = parse_json_response(raw)
    except Exception as e:
        print(f"[Ollama Daily Peak {max_bucket}~{bucket_end}] 실패 (건너뜀): {e}")
        return {}

    if not result:
        return {}

    return {
        "bucket_start": max_bucket,
        "bucket_end": bucket_end,
        "bucket_count": bucket_count,
        "avg_count": avg_count,
        "summary": result.get("summary", ""),
        "has_pattern": result.get("has_pattern", False),
    }

# ── 공개 API ──────────────────────────────────────────────────────────────────


def _build_content(date_str: str, stats: dict, peak_bucket: dict) -> dict:
    return {
        "report_date": date_str,
        "total_count": stats["total_count"],
        "risk_total": stats["risk_total"],
        "risk_rows": [
            {
                "main": r["main"],
                "sub": r["sub"],
                "count": r["count"],
                "main_total": r.get("main_total", r["count"]),
                "summary": r.get("summary", ""),
                "memos": r.get("memos", []),
                "analysis_groups": r.get("analysis_groups", []),
                "insufficient_data": r.get("insufficient_data", False),
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
    """통계만 저장 (Ollama 없음). 프론트엔드 첫 렌더링을 위한 1단계 생성."""
    stats = _fetch_day_stats(date_str)
    content = _build_content(date_str, stats, {})
    generated_at = _save_report(date_str, content)
    content["generated_at"] = generated_at
    return content


async def generate_report(date_str: str) -> dict:
    """통계 + Ollama AI 분석 전체 생성 → DB 저장 → 결과 반환."""
    stats = _fetch_day_stats(date_str)
    await _call_ollama_category_insights(date_str, stats["risk_rows"])
    peak_bucket = await _call_ollama_peak_bucket(date_str, stats["peak_bucket_rows"])
    content = _build_content(date_str, stats, peak_bucket)
    generated_at = _save_report(date_str, content)
    content["generated_at"] = generated_at
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
