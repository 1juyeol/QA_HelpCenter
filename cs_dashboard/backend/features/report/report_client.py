# -*- coding: utf-8 -*-
# 일별 CS 보고서 생성 모듈. DB 쿼리로 통계를 뽑고 Ollama를 두 번 호출해 인사이트를 생성한다.
#
# 주요 흐름:
#   generate_report(date_str)
#     ├─ _fetch_day_stats()               : DB → 총건수, 리스크 5개, 시간대별 건수, 전체 row
#     ├─ _prepare_category_brief()        : extract_symptom_fields + 150자 절삭 → Ollama용 텍스트
#     ├─ _prepare_peak_stats()            : 17~20시 vs 전체 통계 비교표 생성
#     ├─ _call_ollama_category_insights() : Ollama Call 1 — 카테고리별 2줄 분석
#     ├─ _call_ollama_peak_window()       : Ollama Call 2 — 17~20시 이슈 2줄 분석 (데이터 없으면 스킵)
#     └─ reports 테이블 UPSERT → 결과 반환
#
# 리스크 카테고리: frontend/src/api/categories.ts ALLOWED_MAIN + ALLOWED_SPECIFIC와 동일.
# Ollama: core/ollama_client.py 참조. 호출은 2회 순차 실행.
# 정책 2 준수: DB 날짜 필터는 datetime(created_date, '+9 hours') KST 변환.

import json
from collections import Counter
from datetime import datetime
from core.db import get_conn
from core.ollama_client import call_ollama, parse_json_response
from features.issues.classifier import extract_symptom_fields, RULES, SUB_TO_MAIN

INSUFFICIENT_SUMMARY = "구체적 증상 데이터가 충분하지 않아 분석에서 제외되었습니다."
_MIN_ANALYSIS_MEMOS = 3

RISK_MAIN = {"네트워크·앱 오류", "기기·하드웨어 오류"}
RISK_SPECIFIC = {
    "미납·결제 > 미납 관리",
    "해지·유지 상담 > 해지 확정",
    "해지·유지 상담 > 해지금·위약금 문의",
    "교재·물류·배송 > 기기 장기미회수",
    "교재·물류·배송 > 누락·오배송",
}

_MAIN_ORDER = [
    "네트워크·앱 오류",
    "기기·하드웨어 오류",
    "미납·결제",
    "해지·유지 상담",
    "교재·물류·배송",
]


def _is_risk(main: str, sub: str) -> bool:
    if main in RISK_MAIN:
        return True
    return f"{main} > {sub}" in RISK_SPECIFIC


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
                   CAST(strftime('%H', datetime(created_date, '+9 hours')) AS INTEGER) as hour
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

    from collections import defaultdict
    main_sub_memos: dict = defaultdict(lambda: defaultdict(list))
    all_day_rows = []

    for row in rows:
        id_, main, sub, memo, hour = (
            row["id"], row["new_category_main"], row["new_category_sub"],
            row["call_memo"], row["hour"]
        )
        all_day_rows.append({"sub": sub, "hour": hour})
        if main and sub and _is_risk(main, sub):
            main_sub_memos[main][sub].append({"id": id_, "text": memo or ""})

    risk_rows = []
    for main in _MAIN_ORDER:
        if main not in main_sub_memos:
            continue
        subs = main_sub_memos[main]
        top_sub = max(subs, key=lambda s: len(subs[s]))
        memos = subs[top_sub]
        risk_rows.append({
            "main": main,
            "sub": top_sub,
            "count": len(memos),
            "memos": memos,
            "summary": "",
        })

    return {
        "total_count": total,
        "risk_rows": risk_rows,
        "risk_total": sum(r["count"] for r in risk_rows),
        "hourly": hourly,
        "all_day_rows": all_day_rows,
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


def _prepare_peak_stats(date_str: str, all_day_rows: list, hist_peak: float) -> str:
    peak_rows = [r for r in all_day_rows if r["hour"] in (17, 18, 19, 20)]
    day_total = len(all_day_rows)
    peak_total = len(peak_rows)

    if day_total == 0:
        return f"[17~20시 분석 데이터] {date_str}\n데이터 없음"

    peak_cats = Counter(r["sub"] for r in peak_rows if r["sub"])
    day_cats = Counter(r["sub"] for r in all_day_rows if r["sub"])
    hourly = Counter(r["hour"] for r in peak_rows)

    all_subs = set(peak_cats) | set(day_cats)
    cat_ratios = []
    for sub in all_subs:
        pk = peak_cats.get(sub, 0)
        dy = day_cats.get(sub, 0)
        pk_pct = pk / peak_total * 100 if peak_total else 0
        dy_pct = dy / day_total * 100 if day_total else 0
        ratio = pk_pct / dy_pct if dy_pct else 99.0
        cat_ratios.append((sub, pk, pk_pct, dy, dy_pct, ratio))
    cat_ratios.sort(key=lambda x: -x[5])

    lines = [f"[17~20시 분석 데이터] {date_str}", ""]
    lines.append("1. 카테고리 집중도 (이 시간대 비율 vs 하루 전체 비율)")
    for sub, pk, pk_pct, dy, dy_pct, ratio in cat_ratios[:10]:
        flag = "  <- 집중" if ratio >= 1.8 else ("  <- 이 시간대만" if dy == pk else "")
        lines.append(f"  {sub}: 17~20시 {pk}건({pk_pct:.0f}%) / 전체 {dy}건({dy_pct:.0f}%){flag}")

    lines.append("")
    lines.append("2. 17~20시 시간별 추이")
    for h in (17, 18, 19, 20):
        lines.append(f"  {h}시: {hourly.get(h, 0)}건")

    lines.append("")
    today_peak = peak_total
    hist_str = f"{hist_peak}건" if hist_peak else "데이터 부족"
    ratio_vs_hist = f" ({today_peak / hist_peak:.1f}배)" if hist_peak else ""
    lines.append(f"3. 4주 평균 17~20시 대비: 오늘 {today_peak}건 / 평균 {hist_str}{ratio_vs_hist}")

    return "\n".join(lines)


# ── Ollama 프롬프트 ────────────────────────────────────────────────────────────
# system: 역할·규칙·응답 형식 고정 텍스트
# user 템플릿: {date_str}, {cat_label}, {memos}, {stats_text} 자리에 런타임 값 삽입

_SYSTEM_CATEGORY = (
    "당신은 단비교육 공감센터 CS 분석 전문가입니다.\n"
    "CS팀 운영이 아닌 개발·서비스 품질 관점에서 분석하세요.\n"
    "규칙: 코드 블록 없이 JSON만 출력\n"
    '응답 형식:\n{"summary": "두 문장 분석."}'
)

_PROMPT_CATEGORY = (
    "아래는 {date_str} [{cat_label}] CS 상담 메모입니다.\n"
    "개발·서비스 품질 관점에서 어떤 문제가 발생하고 있는지 두 문장으로 분석하세요.\n\n"
    "{memos}"
)

_SYSTEM_PEAK = (
    "당신은 단비교육 공감센터 CS 분석 전문가입니다.\n"
    "개발·품질 관점에서 분석하세요.\n"
    "규칙: 코드 블록 없이 JSON만 출력\n"
    '응답 형식:\n{"key_points": ["한 문장1", "한 문장2"]}'
)

_PROMPT_PEAK = (
    "아래는 CS 상담 데이터의 17~20시 시간대 통계입니다.\n"
    "다른 시간대 대비 이 시간대에 특기할 만한 이슈가 있는지 2줄로 분석해주세요.\n\n"
    "{stats_text}"
)

# ──────────────────────────────────────────────────────────────────────────────


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

        print(f"[Ollama Call 1 - {cat_label}] 프롬프트 길이: {len(prompt)}자\n{'-'*60}\n{prompt}\n{'-'*60}")
        raw = await call_ollama(_SYSTEM_CATEGORY, prompt)
        result = parse_json_response(raw)
        row["summary"] = result.get("summary", "") if result else ""


async def _call_ollama_peak_window(date_str: str, all_day_rows: list, hist_peak: float) -> list:
    """Call 2: 17~20시 통계 기반 2줄 분석. 데이터 없으면 스킵."""
    peak_rows = [r for r in all_day_rows if r["hour"] in (17, 18, 19, 20)]
    if not peak_rows:
        print("[Ollama Call 2] 17~20시 데이터 없음 — 호출 스킵")
        return []

    prompt = _PROMPT_PEAK.format(stats_text=_prepare_peak_stats(date_str, all_day_rows, hist_peak))

    print(f"[Ollama Call 2] 프롬프트 길이: {len(prompt)}자\n{'-'*60}\n{prompt}\n{'-'*60}")
    raw = await call_ollama(_SYSTEM_PEAK, prompt)
    result = parse_json_response(raw)
    if not result:
        return []
    return result.get("key_points", [])


async def generate_report(date_str: str) -> dict:
    """보고서 생성 → DB 저장 → 결과 반환."""
    stats = _fetch_day_stats(date_str)

    await _call_ollama_category_insights(date_str, stats["risk_rows"])

    peak_points = await _call_ollama_peak_window(
        date_str, stats["all_day_rows"], stats["hist_peak"]
    )

    content = {
        "report_date": date_str,
        "total_count": stats["total_count"],
        "risk_total": stats["risk_total"],
        "risk_rows": [
            {
                "main": r["main"],
                "sub": r["sub"],
                "count": r["count"],
                "summary": r.get("summary", ""),
                "analysis_groups": r.get("analysis_groups", []),
                "insufficient_data": r.get("insufficient_data", False),
            }
            for r in stats["risk_rows"]
        ],
        "peak_window_points": peak_points,
        "hourly": stats["hourly"],
    }
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with get_conn() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO reports (report_date, report_type, content, generated_at)
            VALUES (?, 'daily', ?, ?)
            """,
            (date_str, json.dumps(content, ensure_ascii=False), generated_at),
        )
        conn.commit()

    content["generated_at"] = generated_at
    return content


def get_report(date_str: str) -> dict | None:
    """저장된 보고서 조회. 없으면 None."""
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
