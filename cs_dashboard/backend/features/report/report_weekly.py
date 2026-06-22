# -*- coding: utf-8 -*-
# 주간 CS 보고서 생성 모듈. 한 주(월~일) 통계를 집계하고 Ollama를 순차 호출해 인사이트를 생성한다.
#
# 주요 흐름:
#   generate_weekly_report_stats(week_start) → 통계만 저장 (Ollama 없음, 빠른 첫 렌더링)
#   generate_weekly_report(week_start)        → 통계 + Ollama 분석 전체 저장
#     ├─ _fetch_week_stats()           : DB → 7일 통계 (KPI·SQI·스택바·피크·카테고리 비율·리스크 메모)
#     ├─ _call_ollama_weekly_risk()    : Ollama Call 1..N — 리스크 카테고리별 2줄 분석
#     ├─ _call_ollama_weekly_summary() : Ollama Call N+1 — 주간 종합 3문장 분석
#     └─ reports 테이블 UPSERT (report_type='weekly') → 결과 반환
#
# KPI·SQI·스택바·피크는 평일(월~금)만 집계. 일별 바 차트와 AI 분석 메모는 7일 전부 포함.
# week_start는 항상 월요일 날짜(ISO 형식).
#
# 공유 상수·유틸: report_utils.py (RISK_MAIN, _is_risk, _SYSTEM_CATEGORY 등)
# Ollama 클라이언트: core/ollama_client.py
# 정책 2 준수: DB 날짜 필터는 datetime(created_date, '+9 hours') KST 변환

import json
import re
from collections import defaultdict
from datetime import date, datetime, timedelta

from core.db import get_conn
from core.holidays import is_off_day
from core.ollama_client import call_ollama, parse_json_response
from features.issues.classifier import extract_symptom_fields
from features.report.report_utils import (
    INSUFFICIENT_SUMMARY, _MIN_ANALYSIS_MEMOS,
    _MAIN_ORDER, _is_risk, _SYSTEM_CATEGORY,
    RISK_MAIN, RISK_SPECIFIC,
)

# ── Ollama 프롬프트 (주간 전용) ───────────────────────────────────────────────

_PROMPT_WEEKLY_CATEGORY = (
    "아래는 {week_range} [{cat_label}] 관련 CS 상담 메모입니다.\n"
    "이번 주 접수: {count}건 (전체 리스크 CS의 {risk_pct}%)\n"
    "이번 주 최다 접수 요일: {peak_day} ({peak_count}건)\n"
    "자주 등장한 키워드: {top_keywords}\n"
    "\n"
    "메모에서 이번 주 두드러진 패턴이나 특이사항을 분석하세요.\n"
    "첫 문장: 이 주에 어떤 현상이 두드러졌는지 (피크 요일이나 패턴 포함).\n"
    "두 번째 문장: 그 현상이 사용자에게 어떤 영향을 주는지 또는 왜 주목해야 하는지.\n"
    "건수 단순 반복이나 CS 운영 조언은 쓰지 마세요.\n\n"
    "{memos}"
)

_SYSTEM_WEEKLY_SUMMARY = (
    "당신은 단비교육 공감센터 CS 분석 전문가입니다.\n"
    "CS팀 운영이 아닌 개발·서비스 품질 관점에서 분석하세요.\n"
    "규칙: 코드 블록 없이 JSON만 출력\n"
    "규칙: Jira 이슈 번호, 배포 버전, 내부 시스템 ID 등 프롬프트에 없는 구체적 레퍼런스를 절대 언급하지 마세요.\n"
    "규칙: High/Medium/Low 등 우선순위 레이블을 사용하지 마세요.\n"
    "규칙: 제공된 분석에 직접 나타난 내용만 작성하세요. 원인 추론·권고사항·UX 개선 제안은 절대 하지 마세요.\n"
    '응답 형식:\n{"summary": "• 항목1\\n• 항목2\\n• 항목3"}'
)

_PROMPT_WEEKLY_SUMMARY = (
    "{week_range} 주간 CS 요약입니다.\n"
    "총 상담: {total_weekday}건 (평일 기준, 일평균 {daily_avg}건)\n"
    "리스크 CS: {risk_total}건 (리스크율 {risk_pct}%)\n"
    "카테고리별 건수: {category_summary}\n"
    "\n"
    "리스크 카테고리별 분석:\n"
    "{risk_analysis}\n"
    "\n"
    "이번 주 CS를 3~4개 항목(•)으로 종합 분석하세요.\n"
    "각 항목: 핵심 현상 + 서비스·제품 관점 의미 또는 모니터링 포인트.\n"
    "건수 단순 나열이나 CS 운영 조언은 쓰지 마세요.\n"
)

# ── 내부 유틸 ─────────────────────────────────────────────────────────────────

_WEEKDAYS_KO = ['월', '화', '수', '목', '금', '토', '일']

# 키워드 추출 시 제거할 공통 CS 용어
_KW_STOPWORDS = {
    '문의', '상담', '접수', '처리', '고객', '확인', '요청', '연락', '해결', '완료',
    '관련', '사항', '내용', '부분', '경우', '문제', '발생', '계속', '현재', '이용',
    '안내', '드립니다', '합니다', '입니다', '됩니다', '했습니다', '있습니다', '없습니다',
    '것입니다', '주시기', '바랍니다', '주셨', '말씀', '주셔서', '감사', '안녕',
    # 도메인 불용어: 의미 없거나 너무 포괄적인 단어
    '없음', '하심', '기타', '학습기', '진행', '동일', '재부팅', '증상', '하겠다',
    '하셔서', '하시고', '하시면', '하시어', '하시어', '하신다', '하심으로', '하셨다',
    '이후', '이전', '오전', '오후', '오늘', '어제', '내일', '이번', '다시',
    '전화', '통화', '연락처', '번호', '하기', '상기', '해당', '하건', '신건',
}


def _fmt_date_ko(date_str: str) -> str:
    """'YYYY-MM-DD' → 'MM/DD(요)'"""
    d = date.fromisoformat(date_str)
    return f"{date_str[5:].replace('-', '/')}({_WEEKDAYS_KO[d.weekday()]})"


def _weighted_sample_memos(memos: list, max_count: int = 40) -> tuple:
    """일별 건수 비율로 가중 샘플링. (sampled, peak_day_str, peak_count) 반환."""
    if not memos:
        return [], "", 0
    by_day: dict = defaultdict(list)
    for m in memos:
        by_day[m["date"]].append(m)
    peak_day = max(by_day, key=lambda d: len(by_day[d]))
    peak_count = len(by_day[peak_day])
    if len(memos) <= max_count:
        return memos, _fmt_date_ko(peak_day), peak_count
    total = len(memos)
    sampled: list = []
    for day in sorted(by_day):
        quota = max(1, round(len(by_day[day]) / total * max_count))
        sampled.extend(by_day[day][:quota])
    return sampled[:max_count], _fmt_date_ko(peak_day), peak_count


def _extract_top_keywords(texts: list, top_n: int = 7) -> list:
    """메모 텍스트에서 빈도 높은 한글 키워드 추출."""
    freq: dict = {}
    for text in texts:
        for w in re.findall(r'[가-힣]{2,6}', text):
            if w not in _KW_STOPWORDS:
                freq[w] = freq.get(w, 0) + 1
    return sorted(freq, key=lambda w: freq[w], reverse=True)[:top_n]


# ── 내부 함수 ─────────────────────────────────────────────────────────────────


def _fetch_week_stats(week_start: str) -> dict:
    """해당 주(월~일) 통계를 집계한다. KPI·SQI·스택바·피크는 평일(월~금)만, 차트·AI 분석은 7일 전부."""
    d0 = date.fromisoformat(week_start)
    week_end = str(d0 + timedelta(days=6))
    week_days = [(str(d0 + timedelta(days=i)), (d0 + timedelta(days=i)).weekday()) for i in range(7)]

    kst = "datetime(created_date, '+9 hours')"
    col = f"date({kst})"
    h_kst = f"CAST(strftime('%H', {kst}) AS INTEGER)"
    m_kst = f"CAST(strftime('%M', {kst}) AS INTEGER)"

    with get_conn() as conn:
        daily_raw = conn.execute(
            f"SELECT {col} AS day, COUNT(*) AS cnt FROM issues "
            f"WHERE {col} BETWEEN ? AND ? GROUP BY day",
            (week_start, week_end),
        ).fetchall()

        cat_daily = conn.execute(
            f"SELECT {col} AS day, new_category_main AS main, new_category_sub AS sub, COUNT(*) AS cnt "
            f"FROM issues WHERE {col} BETWEEN ? AND ? AND new_category_main IS NOT NULL "
            f"GROUP BY day, main, sub",
            (week_start, week_end),
        ).fetchall()

        cat_total = conn.execute(
            f"SELECT new_category_main AS main, COUNT(*) AS cnt FROM issues "
            f"WHERE {col} BETWEEN ? AND ? AND new_category_main IS NOT NULL "
            f"GROUP BY main ORDER BY cnt DESC",
            (week_start, week_end),
        ).fetchall()

        peak_raw = conn.execute(
            f"SELECT {col} AS day, COUNT(*) AS cnt FROM issues "
            f"WHERE {col} BETWEEN ? AND ? "
            f"AND (({h_kst} BETWEEN 17 AND 19) OR ({h_kst} = 20 AND {m_kst} < 30)) "
            f"GROUP BY day",
            (week_start, week_end),
        ).fetchall()

        risk_memo_raw = conn.execute(
            f"SELECT id, {col} AS day, new_category_main AS main, new_category_sub AS sub, call_memo "
            f"FROM issues WHERE {col} BETWEEN ? AND ? AND new_category_main IS NOT NULL",
            (week_start, week_end),
        ).fetchall()

    daily_map = {r["day"]: r["cnt"] for r in daily_raw}
    peak_map = {r["day"]: r["cnt"] for r in peak_raw}

    daily_counts = [
        {"date": day, "count": daily_map.get(day, 0), "is_weekend": dow >= 5}
        for day, dow in week_days
    ]

    day_risk: dict = defaultdict(int)
    risk_main_day: dict = defaultdict(lambda: defaultdict(int))

    for row in cat_daily:
        if row["sub"] and _is_risk(row["main"], row["sub"]):
            day_risk[row["day"]] += row["cnt"]
            risk_main_day[row["day"]][row["main"]] += row["cnt"]

    sqi_daily = []
    for day, dow in week_days:
        if is_off_day(day):
            continue
        total = daily_map.get(day, 0)
        if total == 0:
            continue
        sqi_daily.append({"date": day, "sqi": round(day_risk.get(day, 0) / total * 100, 1)})

    workday_counts = [daily_map.get(day, 0) for day, _ in week_days if not is_off_day(day)]
    total_weekday = sum(workday_counts)
    nonzero_days = sum(1 for c in workday_counts if c > 0)
    daily_avg = round(total_weekday / max(nonzero_days, 1), 1)
    risk_total = sum(day_risk.get(day, 0) for day, _ in week_days if not is_off_day(day))
    risk_pct = round(risk_total / max(total_weekday, 1) * 100, 1)

    risk_stack = []
    for day, dow in week_days:
        if is_off_day(day):
            continue
        entry = {"date": day}
        for main in _MAIN_ORDER:
            entry[main] = risk_main_day.get(day, {}).get(main, 0)
        risk_stack.append(entry)

    peak_daily = [
        {"date": day, "count": peak_map.get(day, 0)}
        for day, _ in week_days if not is_off_day(day)
    ]

    category_breakdown = [{"main": r["main"], "count": r["cnt"]} for r in cat_total]

    # 전주 KPI (저장된 이전 보고서에서 읽음 — 없으면 None)
    prev_week_start = str(d0 - timedelta(days=7))
    prev_report = get_weekly_report(prev_week_start)
    prev_total_weekday = prev_report["total_weekday"] if prev_report else None
    prev_risk_total = prev_report["risk_total"] if prev_report else None
    prev_daily_avg = prev_report["daily_avg"] if prev_report else None

    risk_memos: dict = defaultdict(list)
    for row in risk_memo_raw:
        if row["sub"] and _is_risk(row["main"], row["sub"]):
            risk_memos[row["main"]].append({"id": row["id"], "date": row["day"], "text": row["call_memo"] or ""})

    risk_rows = []
    for main in _MAIN_ORDER:
        risk_cnt = sum(
            row["cnt"] for row in cat_daily
            if row["main"] == main and row["sub"] and _is_risk(row["main"], row["sub"])
        )
        if risk_cnt == 0:
            continue
        risk_rows.append({
            "main": main,
            "count": risk_cnt,
            "memos": risk_memos.get(main, []),
            "summary": "",
        })

    return {
        "week_start": week_start,
        "week_end": week_end,
        "total_weekday": total_weekday,
        "daily_avg": daily_avg,
        "risk_total": risk_total,
        "prev_total_weekday": prev_total_weekday,
        "prev_risk_total": prev_risk_total,
        "prev_daily_avg": prev_daily_avg,
        "daily_counts": daily_counts,
        "sqi_daily": sqi_daily,
        "category_breakdown": category_breakdown,
        "risk_stack": risk_stack,
        "peak_daily": peak_daily,
        "risk_rows": risk_rows,
    }


# ── Ollama 호출 ───────────────────────────────────────────────────────────────


async def _call_ollama_weekly_risk(week_range: str, risk_rows: list, week_start: str | None = None) -> None:
    """리스크 카테고리별 Ollama 호출. 피크 요일 가중 샘플링 + 키워드 추출 후 분석."""
    total_risk = sum(r["count"] for r in risk_rows)
    for row in risk_rows:
        memos = row["memos"]
        if len(memos) < _MIN_ANALYSIS_MEMOS:
            row["summary"] = INSUFFICIENT_SUMMARY
            continue

        sampled, peak_day, peak_count = _weighted_sample_memos(memos)

        text_counts: dict = {}
        text_order: list = []
        for m in sampled:
            text = extract_symptom_fields(m["text"])
            text = " ".join(text.split())[:100]
            if len(text) >= 20:
                if text not in text_counts:
                    text_counts[text] = 0
                    text_order.append(text)
                text_counts[text] += 1

        lines = []
        raw_texts = []
        for text in text_order:
            count = text_counts[text]
            raw_texts.append(text)
            suffix = f" ({count}건)" if count > 1 else ""
            lines.append(f"[{len(lines)+1}] {text}{suffix}")

        if not lines:
            row["summary"] = INSUFFICIENT_SUMMARY
            continue

        top_kw = _extract_top_keywords(raw_texts)
        risk_pct = round(row["count"] / max(total_risk, 1) * 100, 1)

        def _build_prompt() -> str:
            return _PROMPT_WEEKLY_CATEGORY.format(
                week_range=week_range,
                cat_label=row["main"],
                count=row["count"],
                risk_pct=risk_pct,
                peak_day=peak_day or "-",
                peak_count=peak_count,
                top_keywords=", ".join(top_kw) if top_kw else "없음",
                memos="\n".join(lines),
            )

        prompt = _build_prompt()
        while len(prompt) > 3000 and len(lines) > _MIN_ANALYSIS_MEMOS:
            lines.pop()
            raw_texts.pop()
            top_kw = _extract_top_keywords(raw_texts)
            prompt = _build_prompt()

        print(f"[Ollama Weekly Risk - {row['main']}] 프롬프트 길이: {len(prompt)}자, 샘플: {len(lines)}건")
        print(prompt)
        try:
            raw = await call_ollama(_SYSTEM_CATEGORY, prompt)
            result = parse_json_response(raw)
            row["summary"] = result.get("summary", "") if result else ""
        except Exception as e:
            print(f"[Ollama Weekly Risk - {row['main']}] 실패 (건너뜀): {e}")
            row["summary"] = ""

        # 카테고리 하나 완료될 때마다 중간 저장
        if week_start:
            existing = get_weekly_report(week_start)
            if existing:
                for r in existing.get("risk_rows", []):
                    if r["main"] == row["main"]:
                        r["summary"] = row["summary"]
                        break
                _save_weekly_report(week_start, existing)
                print(f"[Weekly] 중간 저장 완료: {row['main']}")


async def _call_ollama_weekly_summary(stats: dict) -> str:
    """주간 종합 Ollama 호출. 실패 시 빈 문자열 반환."""
    category_summary = ", ".join(
        f"{r['main']} {r['count']}건"
        for r in stats["category_breakdown"][:6]
    )
    risk_analysis = "\n".join(
        f"- {r['main']} ({r['count']}건): {r.get('summary', '')}"
        for r in stats["risk_rows"]
        if r.get("summary") and r.get("summary") != INSUFFICIENT_SUMMARY
    ) or "(분석 없음)"
    prompt = _PROMPT_WEEKLY_SUMMARY.format(
        week_range=f"{stats['week_start']} ~ {stats['week_end']}",
        total_weekday=stats["total_weekday"],
        daily_avg=stats["daily_avg"],
        risk_total=stats["risk_total"],
        risk_pct=round(stats["risk_total"] / max(stats["total_weekday"], 1) * 100, 1),
        category_summary=category_summary,
        risk_analysis=risk_analysis,
    )
    print(f"[Ollama Weekly Summary] 프롬프트 길이: {len(prompt)}자\n{'-'*60}\n{prompt}\n{'-'*60}")
    try:
        raw = await call_ollama(_SYSTEM_WEEKLY_SUMMARY, prompt)
        result = parse_json_response(raw)
        return result.get("summary", "") if result else ""
    except Exception as e:
        print(f"[Ollama Weekly Summary] 실패 (건너뜀): {e}")
        return ""


# ── 공개 API ──────────────────────────────────────────────────────────────────


def _build_weekly_content(stats: dict, weekly_summary: str) -> dict:
    return {
        "week_start": stats["week_start"],
        "week_end": stats["week_end"],
        "total_weekday": stats["total_weekday"],
        "daily_avg": stats["daily_avg"],
        "risk_total": stats["risk_total"],
        "prev_total_weekday": stats.get("prev_total_weekday"),
        "prev_risk_total": stats.get("prev_risk_total"),
        "prev_daily_avg": stats.get("prev_daily_avg"),
        "daily_counts": stats["daily_counts"],
        "sqi_daily": stats["sqi_daily"],
        "category_breakdown": stats["category_breakdown"],
        "risk_stack": stats["risk_stack"],
        "peak_daily": stats["peak_daily"],
        "risk_rows": [
            {"main": r["main"], "count": r["count"], "summary": r.get("summary", "")}
            for r in stats["risk_rows"]
        ],
        "weekly_summary": weekly_summary,
    }


def _save_weekly_report(week_start: str, content: dict) -> str:
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO reports (report_date, report_type, content, generated_at) "
            "VALUES (?, 'weekly', ?, ?)",
            (week_start, json.dumps(content, ensure_ascii=False), generated_at),
        )
        conn.commit()
    return generated_at


async def generate_weekly_report_stats(week_start: str) -> dict:
    """통계만 저장 (Ollama 없음). 프론트엔드 첫 렌더링을 위한 1단계 생성."""
    stats = _fetch_week_stats(week_start)
    content = _build_weekly_content(stats, "")
    generated_at = _save_weekly_report(week_start, content)
    content["generated_at"] = generated_at
    return content


async def generate_weekly_report(week_start: str) -> dict:
    """통계 + Ollama AI 분석 전체 생성 → DB 저장 → 결과 반환."""
    stats = _fetch_week_stats(week_start)
    week_range = f"{stats['week_start']} ~ {stats['week_end']}"
    await _call_ollama_weekly_risk(week_range, stats["risk_rows"], week_start=week_start)
    weekly_summary = await _call_ollama_weekly_summary(stats)
    content = _build_weekly_content(stats, weekly_summary)
    generated_at = _save_weekly_report(week_start, content)
    content["generated_at"] = generated_at
    return content


def get_weekly_risk_memos(
    week_start: str, main: str, page: int = 1, page_size: int = 20,
) -> dict:
    """주간 리스크 카테고리 메모 페이지네이션 조회. 리스크 소분류만 포함."""
    d0 = date.fromisoformat(week_start)
    week_end = str(d0 + timedelta(days=6))
    kst = "datetime(created_date, '+9 hours')"
    col = f"date({kst})"
    offset = (page - 1) * page_size

    if main in RISK_MAIN:
        sub_clause = ""
        sub_params: list = []
    else:
        risk_subs = [s.split(" > ", 1)[1] for s in RISK_SPECIFIC if s.startswith(f"{main} > ")]
        if not risk_subs:
            return {"memos": [], "total": 0, "page": page, "page_size": page_size}
        placeholders = ",".join("?" * len(risk_subs))
        sub_clause = f"AND new_category_sub IN ({placeholders})"
        sub_params = risk_subs

    base = [week_start, week_end, main] + sub_params

    with get_conn() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) FROM issues "
            f"WHERE {col} BETWEEN ? AND ? AND new_category_main = ? {sub_clause}",
            base,
        ).fetchone()[0]

        rows = conn.execute(
            f"SELECT {col} AS day, new_category_sub AS sub, call_memo "
            f"FROM issues "
            f"WHERE {col} BETWEEN ? AND ? AND new_category_main = ? {sub_clause} "
            f"ORDER BY created_date LIMIT ? OFFSET ?",
            base + [page_size, offset],
        ).fetchall()

    return {
        "memos": [{"date": r["day"], "sub": r["sub"] or "", "text": r["call_memo"] or ""} for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


async def analyze_weekly_category(week_start: str, main: str) -> dict:
    """특정 주간 리스크 카테고리만 Ollama 분석. 기존 보고서가 있으면 summary patch-save."""
    stats = _fetch_week_stats(week_start)
    week_range = f"{stats['week_start']} ~ {stats['week_end']}"
    target_rows = [r for r in stats["risk_rows"] if r["main"] == main]
    if not target_rows:
        return {"error": f"'{main}' 카테고리 없음"}
    await _call_ollama_weekly_risk(week_range, target_rows)
    row = target_rows[0]

    existing = get_weekly_report(week_start)
    if existing:
        for r in existing.get("risk_rows", []):
            if r["main"] == main:
                r["summary"] = row.get("summary", "")
                break
        _save_weekly_report(week_start, existing)

    return {
        "main": main,
        "count": row["count"],
        "summary": row.get("summary", ""),
        "insufficient_data": row.get("summary") == INSUFFICIENT_SUMMARY,
    }


async def analyze_weekly_summary(week_start: str) -> dict:
    """주간 종합 브리핑만 Ollama 분석. 기존 보고서의 risk summary를 참조해 생성 후 patch-save."""
    stats = _fetch_week_stats(week_start)
    existing = get_weekly_report(week_start)
    if existing:
        for r in stats["risk_rows"]:
            stored = next((s for s in existing.get("risk_rows", []) if s["main"] == r["main"]), None)
            if stored:
                r["summary"] = stored.get("summary", "")
    summary = await _call_ollama_weekly_summary(stats)
    if existing:
        existing["weekly_summary"] = summary
        _save_weekly_report(week_start, existing)
    return {"summary": summary}


def get_weekly_report(week_start: str) -> dict | None:
    """저장된 주간 보고서 조회. 없으면 None."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT content, generated_at FROM reports WHERE report_date = ? AND report_type = 'weekly'",
            (week_start,),
        ).fetchone()
    if not row:
        return None
    result = json.loads(row["content"])
    result["generated_at"] = row["generated_at"]
    return result
