# -*- coding: utf-8 -*-
# 주간 CS 보고서 생성 모듈. 한 주(월~일) 통계를 집계하고 Gemma를 순차 호출해 인사이트를 생성한다.
#
# 주요 흐름:
#   generate_weekly_report_stats(week_start) → 통계만 저장 (Gemma 없음, 빠른 첫 렌더링)
#   generate_weekly_report(week_start)        → 통계 + Gemma 분석 전체 저장
#     ├─ _fetch_week_stats()           : DB → 7일 통계 (KPI·SQI·스택바·피크·카테고리 비율·리스크 메모)
#     ├─ _call_gemma_weekly_risk()    : Gemma Call 1..N — 리스크 카테고리별 2줄 분석
#     ├─ _call_gemma_weekly_summary() : Gemma Call N+1 — 주간 종합 3문장 분석
#     └─ reports 테이블 UPSERT (report_type='weekly') → 결과 반환
#
# KPI·SQI·스택바·피크는 평일(월~금)만 집계. 일별 바 차트와 AI 분석 메모는 7일 전부 포함.
# week_start는 항상 월요일 날짜(ISO 형식).
#
# 반복 Wings 티켓(wings_repeat_new_count/stale_count)은 insights_cache의 wings_tickets를
# 그대로 읽어 이번 주 신규/방치로만 센다(_wings_repeat_counts) — AI 분석이 아니라 카테고리
# 비중도 다루지 않는 단순 집계다. 개별 학부모를 짚는 내용은 인사이트 페이지에서만 다룬다.
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
from core.prompt_settings import get_prompt_text
from features.issues.classifier import extract_symptom_fields
from features.insights.insights_cache import _read_cache
from features.report.report_utils import (
    INSUFFICIENT_SUMMARY, _MIN_ANALYSIS_MEMOS,
    _MAIN_ORDER, _is_risk,
    RISK_MAIN, RISK_SPECIFIC, describe_gemma_failure,
)

# ── Gemma 프롬프트 (주간 전용) ───────────────────────────────────────────────
#
# 프롬프트 아키텍처 원칙: 시스템 프롬프트 = 규칙(어떻게 써야 하는지), 유저 프롬프트 = 데이터
# (무엇을 보고 쓰는지). 예전엔 _PROMPT_WEEKLY_CATEGORY/_PROMPT_WEEKLY_SUMMARY 안에 데이터와
# 지시문이 섞여 있었다 — 프로토타입 단계에서 그렇게 만들어진 뒤 한 번도 정리가 안 된 상태였다.
#
# _SYSTEM_WEEKLY_CATEGORY는 report_utils.py의 _SYSTEM_CATEGORY(일별 전용, 공용이 아님)를
# 그대로 복사한 것에 주간 전용 규칙 한 줄만 추가한 것이다 — 자동화 관리에서 일별/주간 탭을
# 완전히 독립적으로 편집할 수 있어야 해서(한쪽 탭에서 고치면 다른 탭도 같이 바뀌면 안 됨),
# 내용이 같더라도 상수 자체는 분리해뒀다. 유저 프롬프트(_PROMPT_WEEKLY_CATEGORY)에서
# {count}(카테고리 전체 건수)는 뺐다 — 이미 화면(리스크 카테고리별 AI 분석 카드의 배지)에
# 표시되고 있어서 Gemma가 다시 언급하면 중복이다. {risk_pct}/{peak_day}/{peak_count}/
# {top_keywords}는 화면 어디에도 노출되지 않는 정보라 남겨두고, 대신 이걸 "언급해서
# 써라"는 규칙을 _SYSTEM_WEEKLY_CATEGORY에 추가해서 실제로 쓰이게 했다(전에는 이 지시문이
# 없어서 데이터만 던져지고 방치되고 있었다).
_SYSTEM_WEEKLY_CATEGORY = (
    "<role>\n"
    "당신은 단비교육 공감센터의 CS 데이터 분석가입니다. 리스크 카테고리별 CS 상담 메모를 검토해서\n"
    "개발·서비스 품질팀이 우선 조사할 결함 패턴을 파악하는 요약을 작성합니다.\n"
    "</role>\n\n"
    "<rules>\n"
    "- JSON 객체 하나만 출력합니다. 백틱(`)이나 마크다운 코드 블록으로 감싸지 않습니다.\n"
    "- summary는 최대 4문장입니다. 사유가 적으면 그보다 짧아도 됩니다 — 불필요하게 문장 수를\n"
    "  채우지 마세요. 마지막 문장은 그 현상들이 사용자에게 미치는 영향 또는 왜 심각한지이고,\n"
    "  그 앞 문장(들)은 결함 사유를 건수와 함께 언급합니다.\n"
    "- 제공된 메모에 실제로 나타난 내용만 씁니다. 원인 추론, 권고사항, UX 개선 제안은 쓰지 않습니다.\n"
    "- Jira 이슈 번호, 배포 버전, 내부 시스템 ID 등 메모에 없는 구체적 레퍼런스는 언급하지 않습니다.\n"
    "- High/Medium/Low 같은 우선순위 레이블은 쓰지 않습니다.\n"
    "- 해석·판단이 들어가면 '~로 보입니다', '~가능성이 있습니다', '~추정됩니다' 같은 추측 표현을\n"
    "  씁니다. 단정하지 않습니다.\n"
    "- 건수만 반복하는 문장('N건 접수됨')으로 문장을 채우지 마세요. CS 운영 조언도 쓰지 않습니다.\n"
    "- 메모 앞에 사유별 건수·비율이 제공된 경우, 상위 1개만 언급하지 말고 **제공된 사유를 최대한\n"
    "  많이(문장 수 한도 안에서)** 인용하세요. 1위만 언급하면 카테고리 순위는 매일 거의 고정되어\n"
    "  있어서 보고서가 매번 똑같은 내용처럼 보입니다. 인용하는 사유마다 반드시 'N건(P%)' 형식으로\n"
    "  건수와 비율을 함께 씁니다 — 비율만 쓰고 건수를 생략하거나 그 반대로 하지 마세요. 제공되지\n"
    "  않았다면 메모에 나타난 실제 표현을 근거로 언급하세요. '다수', '여러 건', '반복적으로' 같은\n"
    "  뭉뚱그린 표현만으로 근거를 대신하지 마세요.\n"
    "- 마지막 문장(영향·심각성)도 메모에 실제로 언급된 결과·조치(예: 사용 불가, 교체 요청,\n"
    "  재부팅 등)만 근거로 삼습니다. 메모에 없는 새로운 사건이나 용어(예: '시스템 정지',\n"
    "  '학습 진행 방해')를 만들어내지 않습니다.\n"
    "- 카테고리 전체 비중, 최다 접수 요일, 자주 등장한 키워드가 함께 제공되면, 그 내용이 위에서\n"
    "  인용한 사유들과 실제로 부합할 때만 자연스럽게 포함하세요. 억지로 모든 문장에 욱여넣지\n"
    "  않아도 됩니다.\n"
    "</rules>\n\n"
    "<example>\n"
    "사유별 건수가 '충전·전원 불량: 82건 (38.5%)', '터치·입력 불량: 34건 (15.9%)',\n"
    "'화면 이상: 21건 (9.8%)', '부팅 오류: 12건 (5.6%)'로 제공됐다면:\n"
    '{"summary": "충전·전원 불량이 82건(38.5%)으로 가장 많고, 터치·입력 불량 34건(15.9%)이 '
    '뒤를 잇습니다. 화면 이상 21건(9.8%), 부팅 오류 12건(5.6%)도 반복적으로 접수되고 있습니다. '
    '이 중 다수가 방전·꺼짐 증상을 동반해 학습기를 정상적으로 사용할 수 없는 것으로 보입니다."}\n'
    "\n"
    "사유가 1~2개뿐이면 그만큼만 짧게 씁니다:\n"
    '{"summary": "네트워크 연결 불안정이 6건(전체의 대부분)으로 나타났습니다. 이 증상이 발생하면 '
    '화상 수업 중 연결이 끊겨 수업을 이어가기 어려운 것으로 보입니다."}\n'
    "</example>\n\n"
    "위 예시와 같은 형식으로, JSON 객체 하나만 출력하세요."
)

_PROMPT_WEEKLY_CATEGORY = (
    "아래는 {week_range} [{cat_label}] 관련 CS 상담 메모입니다.\n"
    "이번 주 접수: {count}건 (전체 리스크 CS의 {risk_pct}%)\n"
    "이번 주 최다 접수 요일: {peak_day} ({peak_count}건)\n"
    "자주 등장한 키워드: {top_keywords}\n"
    "\n"
    "{memos}"
)

_SYSTEM_WEEKLY_SUMMARY = (
    "당신은 단비교육 공감센터 CS 분석 전문가입니다.\n"
    "CS팀 운영이 아닌 개발·서비스 품질 관점에서 분석하세요.\n"
    "규칙: 코드 블록 없이 JSON만 출력\n"
    "규칙: Jira 이슈 번호, 배포 버전, 내부 시스템 ID 등 프롬프트에 없는 구체적 레퍼런스를 절대 언급하지 마세요.\n"
    "규칙: High/Medium/Low 등 우선순위 레이블을 사용하지 마세요.\n"
    "규칙: 제공된 분석에 직접 나타난 내용만 작성하세요. 원인 추론·권고사항·UX 개선 제안은 절대 하지 마세요.\n"
    "규칙: 이번 주 CS를 3~4개 항목(•)으로 종합 분석하세요.\n"
    "규칙: 각 항목은 핵심 현상 + 서비스·제품 관점 의미 또는 모니터링 포인트로 구성합니다.\n"
    "규칙: 해석이나 판단이 포함될 경우 반드시 '~로 보입니다', '~가능성이 있습니다' 같은 추측 표현을 사용하세요.\n"
    "규칙: 마지막 항목은 반드시 다음 주 확인이 필요한 영역(반복 인입, 관련 티켓, 세부 유형 지속 여부 등)으로 마무리하세요.\n"
    "규칙: 건수 단순 나열이나 CS 운영 조언은 쓰지 마세요.\n"
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


def _classify_wings_repeat(tickets: list, week_start: str, week_end: str) -> dict:
    """반복 Wings 티켓 목록(이미 로드된 것) 중 이번 주(week_start~week_end)에 처음 반복
    언급된 건은 신규, 그 이전부터 이어져 아직 열려있는 건은 방치로 센다. 프론트
    weeklyRiskSummary.ts의 buildWeeklyRiskSummary()와 같은 로직."""
    new_count = 0
    stale_count = 0
    for t in tickets:
        first_day = (t.get("first_date") or "")[:10]
        if week_start <= first_day <= week_end:
            new_count += 1
        elif first_day < week_start:
            stale_count += 1
    return {"new_count": new_count, "stale_count": stale_count}


def _wings_repeat_counts(week_start: str, week_end: str) -> dict:
    """insights_cache의 wings_tickets(현재 열려있는 반복 Wings 티켓만)를 읽어 신규/방치를
    센다. 캐시가 비어 있으면(수집 미승인 등) 0/0을 반환한다."""
    row = _read_cache("wings_tickets")
    if not row:
        return {"new_count": 0, "stale_count": 0}
    return _classify_wings_repeat(json.loads(row["data"]), week_start, week_end)


# ── 내부 함수 ─────────────────────────────────────────────────────────────────


def _fetch_week_stats(week_start: str, include_prev: bool = True) -> dict:
    """해당 주(월~일) 통계를 집계한다. KPI·SQI·스택바·피크는 평일(월~금)만, 차트·AI 분석은 7일 전부.
    include_prev=False면 전주 비교값을 계산하지 않는다 — 전주 값 계산 시 자기 자신을 한 번 더
    호출하므로, 재귀가 전전주까지 이어지지 않도록 막는 용도."""
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

    # 소분류 일별 추이: { main → [{date, sub1: N, ...}, ...] } (평일만)
    risk_sub_day: dict = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    for row in cat_daily:
        if row["sub"] and _is_risk(row["main"], row["sub"]):
            risk_sub_day[row["main"]][row["day"]][row["sub"]] += row["cnt"]

    risk_sub_stack: dict = {}
    for main in _MAIN_ORDER:
        if main not in risk_sub_day:
            continue
        all_subs: set = set()
        for day_data in risk_sub_day[main].values():
            all_subs.update(day_data.keys())
        entries = []
        for day, _ in week_days:
            if is_off_day(day):
                continue
            entry: dict = {"date": day}
            for sub in all_subs:
                entry[sub] = risk_sub_day[main].get(day, {}).get(sub, 0)
            entries.append(entry)
        risk_sub_stack[main] = entries

    category_breakdown = [{"main": r["main"], "count": r["cnt"]} for r in cat_total]

    # 전주 KPI + 소분류 스택 (issues 원본에서 직접 계산 — 전주 보고서가 저장돼 있는지와 무관하다)
    if include_prev:
        prev_week_start = str(d0 - timedelta(days=7))
        prev_stats = _fetch_week_stats(prev_week_start, include_prev=False)
        prev_total_weekday = prev_stats["total_weekday"]
        prev_risk_total = prev_stats["risk_total"]
        prev_daily_avg = prev_stats["daily_avg"]
        prev_risk_sub_stack = prev_stats["risk_sub_stack"]
        # wings_repeat 카운트는 insights_cache(현재 열려있는 티켓만 남는 스냅샷)에 의존해서
        # 위 항목들처럼 실시간 재계산으로 과거를 재현할 수 없다 — 해결된 티켓은 캐시에서
        # 이미 빠져있어서 지난주를 다시 계산하면 과소 집계된다. 그래서 지난주 생성 시점에
        # 저장해둔 값을 그대로 가져온다 — 지난주 보고서가 없으면(생성 전 등) None이며,
        # 프론트는 다른 KPI 카드의 delta=None과 같은 방식으로 처리한다(배지 자체를 안 보여줌).
        prev_report = get_weekly_report(prev_week_start)
        prev_wings_repeat_new_count = prev_report.get("wings_repeat_new_count") if prev_report else None
        prev_wings_repeat_stale_count = prev_report.get("wings_repeat_stale_count") if prev_report else None
    else:
        prev_total_weekday = prev_risk_total = prev_daily_avg = None
        prev_risk_sub_stack = {}
        prev_wings_repeat_new_count = prev_wings_repeat_stale_count = None

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

    wings_repeat = _wings_repeat_counts(week_start, week_end)

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
        "risk_sub_stack": risk_sub_stack,
        "risk_sub_stack_prev": prev_risk_sub_stack,
        "wings_repeat_new_count": wings_repeat["new_count"],
        "wings_repeat_stale_count": wings_repeat["stale_count"],
        "prev_wings_repeat_new_count": prev_wings_repeat_new_count,
        "prev_wings_repeat_stale_count": prev_wings_repeat_stale_count,
    }


# ── Gemma 호출 ───────────────────────────────────────────────────────────────


async def _call_gemma_weekly_risk(week_range: str, risk_rows: list, week_start: str | None = None) -> None:
    """리스크 카테고리별 Gemma 호출. 피크 요일 가중 샘플링 + 키워드 추출 후 분석.
    각 row에 gemma_error를 남긴다: 성공/데이터부족이면 None, 실패면 실패 사유 문자열
    (일별 보고서와 동일한 이유 — 실패가 print()로만 사라지지 않게)."""
    total_risk = sum(r["count"] for r in risk_rows)
    for row in risk_rows:
        memos = row["memos"]
        if len(memos) < _MIN_ANALYSIS_MEMOS:
            row["summary"] = INSUFFICIENT_SUMMARY
            row["gemma_error"] = None
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
            row["gemma_error"] = None
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

        print(f"[Gemma Weekly Risk - {row['main']}] 프롬프트 길이: {len(prompt)}자, 샘플: {len(lines)}건")
        print(prompt)
        try:
            raw = await call_gemma(get_prompt_text("weekly_category", _SYSTEM_WEEKLY_CATEGORY), prompt)
            result = parse_json_response(raw)
            if result and result.get("summary"):
                row["summary"] = result["summary"]
                row["gemma_error"] = None
            else:
                row["summary"] = ""
                row["gemma_error"] = describe_gemma_failure(raw)
                print(f"[Gemma Weekly Risk - {row['main']}] {row['gemma_error']}")
        except Exception as e:
            row["summary"] = ""
            row["gemma_error"] = str(e)
            print(f"[Gemma Weekly Risk - {row['main']}] 실패 (건너뜀): {e}")

        # 카테고리 하나 완료될 때마다 중간 저장
        if week_start:
            existing = get_weekly_report(week_start)
            if existing:
                for r in existing.get("risk_rows", []):
                    if r["main"] == row["main"]:
                        r["summary"] = row["summary"]
                        r["gemma_error"] = row.get("gemma_error")
                        break
                _save_weekly_report(week_start, existing)
                print(f"[Weekly] 중간 저장 완료: {row['main']}")


async def _call_gemma_weekly_summary(stats: dict) -> tuple[str, str | None]:
    """주간 종합 Gemma 호출. (summary, gemma_error) 튜플 반환 — 실패 시 summary=""·gemma_error=사유."""
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
    print(f"[Gemma Weekly Summary] 프롬프트 길이: {len(prompt)}자\n{'-'*60}\n{prompt}\n{'-'*60}")
    try:
        raw = await call_gemma(get_prompt_text("weekly_summary", _SYSTEM_WEEKLY_SUMMARY), prompt)
        result = parse_json_response(raw)
        if result and result.get("summary"):
            return result["summary"], None
        return "", describe_gemma_failure(raw)
    except Exception as e:
        print(f"[Gemma Weekly Summary] 실패 (건너뜀): {e}")
        return "", str(e)


# ── 공개 API ──────────────────────────────────────────────────────────────────


def _build_weekly_content(stats: dict, weekly_summary: str, weekly_summary_error: str | None = None) -> dict:
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
        "risk_sub_stack": stats.get("risk_sub_stack", {}),
        "risk_sub_stack_prev": stats.get("risk_sub_stack_prev", {}),
        "peak_daily": stats["peak_daily"],
        "risk_rows": [
            {"main": r["main"], "count": r["count"], "summary": r.get("summary", ""), "gemma_error": r.get("gemma_error")}
            for r in stats["risk_rows"]
        ],
        "wings_repeat_new_count": stats.get("wings_repeat_new_count", 0),
        "wings_repeat_stale_count": stats.get("wings_repeat_stale_count", 0),
        "prev_wings_repeat_new_count": stats.get("prev_wings_repeat_new_count"),
        "prev_wings_repeat_stale_count": stats.get("prev_wings_repeat_stale_count"),
        "weekly_summary": weekly_summary,
        "weekly_summary_error": weekly_summary_error,
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
    """통계만 저장 (Gemma 없음). 프론트엔드 첫 렌더링을 위한 1단계 생성."""
    stats = _fetch_week_stats(week_start)
    content = _build_weekly_content(stats, "")
    generated_at = _save_weekly_report(week_start, content)
    content["generated_at"] = generated_at
    return content


async def generate_weekly_report(week_start: str) -> dict:
    """통계 + Gemma AI 분석 전체 생성 → DB 저장 → 결과 반환."""
    stats = _fetch_week_stats(week_start)
    week_range = f"{stats['week_start']} ~ {stats['week_end']}"
    await _call_gemma_weekly_risk(week_range, stats["risk_rows"], week_start=week_start)
    weekly_summary, weekly_summary_error = await _call_gemma_weekly_summary(stats)
    content = _build_weekly_content(stats, weekly_summary, weekly_summary_error)
    generated_at = _save_weekly_report(week_start, content)
    content["generated_at"] = generated_at
    return content


def get_weekly_risk_memos(
    week_start: str, main: str, page: int = 1, page_size: int = 10, sub: str = "",
) -> dict:
    """주간 리스크 카테고리 메모 페이지네이션 조회. 리스크 소분류만 포함. sub 지정 시 해당 소분류만."""
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

    extra_sub_clause = "AND new_category_sub = ?" if sub else ""
    extra_sub_params: list = [sub] if sub else []

    base = [week_start, week_end, main] + sub_params + extra_sub_params

    with get_conn() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) FROM issues "
            f"WHERE {col} BETWEEN ? AND ? AND new_category_main = ? {sub_clause} {extra_sub_clause}",
            base,
        ).fetchone()[0]

        rows = conn.execute(
            f"SELECT {col} AS day, new_category_sub AS sub, call_memo "
            f"FROM issues "
            f"WHERE {col} BETWEEN ? AND ? AND new_category_main = ? {sub_clause} {extra_sub_clause} "
            f"ORDER BY created_date DESC LIMIT ? OFFSET ?",
            base + [page_size, offset],
        ).fetchall()

    return {
        "memos": [{"date": r["day"], "sub": r["sub"] or "", "text": r["call_memo"] or ""} for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


async def analyze_weekly_category(week_start: str, main: str) -> dict:
    """특정 주간 리스크 카테고리만 Gemma 분석. 기존 보고서가 있으면 summary patch-save."""
    stats = _fetch_week_stats(week_start)
    week_range = f"{stats['week_start']} ~ {stats['week_end']}"
    target_rows = [r for r in stats["risk_rows"] if r["main"] == main]
    if not target_rows:
        return {"error": f"'{main}' 카테고리 없음"}
    await _call_gemma_weekly_risk(week_range, target_rows)
    row = target_rows[0]

    existing = get_weekly_report(week_start)
    if existing:
        for r in existing.get("risk_rows", []):
            if r["main"] == main:
                r["summary"] = row.get("summary", "")
                r["gemma_error"] = row.get("gemma_error")
                break
        _save_weekly_report(week_start, existing)

    return {
        "main": main,
        "count": row["count"],
        "summary": row.get("summary", ""),
        "insufficient_data": row.get("summary") == INSUFFICIENT_SUMMARY,
        "gemma_error": row.get("gemma_error"),
    }


async def analyze_weekly_summary(week_start: str) -> dict:
    """주간 종합 브리핑만 Gemma 분석. 기존 보고서의 risk summary를 참조해 생성 후 patch-save."""
    stats = _fetch_week_stats(week_start)
    existing = get_weekly_report(week_start)
    if existing:
        for r in stats["risk_rows"]:
            stored = next((s for s in existing.get("risk_rows", []) if s["main"] == r["main"]), None)
            if stored:
                r["summary"] = stored.get("summary", "")
    summary, gemma_error = await _call_gemma_weekly_summary(stats)
    if existing:
        existing["weekly_summary"] = summary
        existing["weekly_summary_error"] = gemma_error
        _save_weekly_report(week_start, existing)
    return {"summary": summary, "gemma_error": gemma_error}


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


def get_latest_weekly_report() -> dict | None:
    """가장 최근 저장된 주간 보고서 조회. 없으면 None."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT content, generated_at FROM reports WHERE report_type = 'weekly' ORDER BY report_date DESC LIMIT 1",
        ).fetchone()
    if not row:
        return None
    result = json.loads(row["content"])
    result["generated_at"] = row["generated_at"]
    return result


def get_wings_repeat_trend(limit_weeks: int = 8) -> list[dict]:
    """저장된 주간보고서들의 반복 Wings 티켓 신규/방치 건수를 주차 오름차순으로 모은다 —
    "반복 Wings 티켓" 섹션의 미니 추이 차트용. wings_repeat_new_count가 없는 보고서(이
    필드를 추가하기 전에 생성된 것)는 건너뛴다."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT report_date, content FROM reports WHERE report_type = 'weekly' "
            "ORDER BY report_date DESC LIMIT ?",
            (limit_weeks,),
        ).fetchall()
    trend = []
    for row in rows:
        content = json.loads(row["content"])
        if "wings_repeat_new_count" not in content:
            continue
        trend.append({
            "week_start": row["report_date"],
            "new_count": content["wings_repeat_new_count"],
            "stale_count": content["wings_repeat_stale_count"],
        })
    trend.sort(key=lambda t: t["week_start"])
    return trend
