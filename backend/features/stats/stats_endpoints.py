# -*- coding: utf-8 -*-
# 통계 집계 API 라우터 (10개 엔드포인트). 모두 GET 요청이며 쿼리 파라미터로 기간을 지정한다.
# hourly_range       : 날짜 범위의 30분 버킷별 건수 반환 — 차트 X축 26개 버킷 고정 출력.
# daily              : 일별 건수 (period=day/week/month).
# category           : 대분류·소분류·버킷 조합 필터 집계 — 카테고리 드릴다운용.
# weekly             : 주차별 건수 (최근 4주). monthly : 월별 건수 (최근 3개월).
# category_daily     : 최근 4주 일별·카테고리별 건수, 주말·공휴일 제외 — 일별 SQI 계산용.
# keyword_trend      : call_memo 한국어 명사 중 이번 주 급증 키워드 TOP 10 — 탐지 이력 기록용.
#                      kiwipiepy로 형태소 분석, 결과를 insights_cache에 캐시한다 (당일 유효).
# keyword_memos      : 이번 주 call_memo 중 특정 keyword를 포함하는 메모 목록 — 키워드 클릭 시 팝업용.
# keyword_history    : 최근 N일치 insights_cache를 읽어 키워드 단위로 집계 (탐지 이력 탭용).
#                      자동 상태 계산: 지속 언급 / 재급증 / 신규 탐지 / 감소 추세 / 최근 미탐지
# keyword_trend_dates: 특정 키워드의 날짜별 탐지 이력 반환 (키워드 상세 흐름 차트용).
import json
from collections import defaultdict
from datetime import date, timedelta
from fastapi import APIRouter, Query
from core.db import get_conn
from core.date_bucket_utils import BUCKET_SQL, BUCKETS, _buckets_where, _period_where, _four_week_range
from core.holidays import is_off_day
from features.report.report_utils import RISK_MAIN

router = APIRouter()

# CS 메모에서 항상 등장하지만 트렌드 분석 가치가 없는 일반 관리 용어 및 서비스 고유 명사.
# keyword_trend 결과에서 이 단어들은 제외한다.
# 오탈자로 인해 kiwipiepy가 동사를 NNG로 잘못 태깅할 때 후처리로 걸러낸다.
# 예: "꼿았다"(꽂았다 오탈자) → 었다/았다 계열, "뺏다" → ㅅ다/ㄷ다 받침+다 형태
_VERB_ENDINGS = ('았다', '었다', '했다', '았어', '었어', '한다', '는다', 'ㄴ다', '겠다',
                 '뺏다', '뺐다', '됐다', '됬다', '봤다', '봤어', '왔다', '갔다')

# 영어 관사·전치사·접속사 등 SL 태그로 추출되는 무의미 영어 불용어
_ENGLISH_STOP_WORDS = {
    'the', 'and', 'on', 'in', 'is', 'it', 'he', 'she', 'his', 'her',
    'you', 'we', 'go', 'are', 'was', 'to', 'of', 'at', 'or', 'an',
    'be', 'by', 'do', 'if', 'my', 'no', 'so', 'up', 'Let', 'How',
    'Its', 'Big', 'Our', 'Can', 'Did', 'Get', 'Got', 'Has', 'Had',
    'Not', 'Now', 'Old', 'Own', 'Too', 'Two', 'Way', 'Who', 'Why',
}

CS_STOP_WORDS = {
    '안내', '확인', '진행', '처리', '연락', '문의', '완료', '예정',
    '요청', '상담', '후속', '관리', '이력', '관련', '해당',
    '사항', '확인사항', '안내사항', '후속관리', '미진행',
    '없음', '있음', '불가', '가능', '접수', '증상',
    '특이사항', '처리내용', '처리사항',
    '고객', '학부모', '학생', '아이', '선생님',
    '학습기', '단말기', '윙크', '학습', '기기',
    '선출고', '후회수', '출고', '회수', '배송', '주소',
    '전화', '문자', '통화', '연결',
    # 호칭·인사말
    '어머님', '아버님', '어머니', '아버지', '안녕', '고객님',
    # 시간·상황 묘사어
    '오전', '오후', '저녁', '아침', '차례', '평일', '주말',
    # 상담 업무 맥락어
    '담당', '부서', '추후', '희망', '독려', '참고', '안정',
    '선택', '단독', '수업', '결제', '형제', '회사',
    # 문맥 설명어·시간 표현
    '환기', '특이', '어려움', '어제', '기간', '흥미', '엄마',
    # 수량 수식어
    '정도',
}

_kiwi = None


def _get_kiwi():
    global _kiwi
    if _kiwi is None:
        from kiwipiepy import Kiwi
        _kiwi = Kiwi()
    return _kiwi


def extract_nouns_batch(texts: list) -> list:
    """call_memo 리스트를 한 번에 형태소 분석한다 (배치 모드, 단건 반복보다 훨씬 빠름).
    NNP(고유명사)는 사람 이름·브랜드명이 섞여 있어 제외한다.
    SL(외래어)을 포함해 인플루언서·OTA 등 외래어 표기 단어가 조각나지 않도록 한다.
    반환: 입력 리스트와 같은 길이의 set 리스트. 각 set은 해당 메모의 NNG+SL 명사 집합."""
    kiwi = _get_kiwi()
    results = []
    for analysis in kiwi.analyze(texts):
        # analyze() → [(token_list, score), ...]; [0][0]이 최적 분석 결과의 토큰 리스트
        nouns = {
            tok.form for tok in analysis[0][0]
            if tok.tag in ('NNG', 'SL')
            and len(tok.form) >= 2
            and tok.form not in CS_STOP_WORDS
            and tok.form not in _ENGLISH_STOP_WORDS
            and not any(tok.form.endswith(e) for e in _VERB_ENDINGS)
        }
        results.append(nouns)
    return results


def compute_keyword_trend(this_week_counts: dict, prior_counts: dict) -> list:
    """집계된 단어 빈도로 이번 주 급증 키워드 TOP 10을 계산한다 (순수 함수, DB·형태소 분석과 분리).

    this_week_counts: {단어: 이번주 포함 메모 수}
    prior_counts:     {단어: {주차 월요일: 해당 주 포함 메모 수}}  (직전 4주)

    증가율 = 이번주_빈도 / max(직전4주_주당평균, 1)
    신규   = 직전 4주 동안 0회 등장
    이번 주 최소 5건 이상 & 증가율 2.0배 이상인 단어만 포함하며(오탐 방지), 증가율 내림차순 TOP 10을 반환한다.
    반환: [{"word", "this_week", "avg_per_week", "growth_rate", "is_new"}, ...]"""
    results = []
    for word, this_count in this_week_counts.items():
        if this_count < 5:
            continue
        prior_total = sum(prior_counts[word].values()) if word in prior_counts else 0
        avg_per_week = round(prior_total / 4, 1)
        is_new = prior_total == 0
        growth_rate = round(this_count / max(avg_per_week, 1), 1)
        if growth_rate < 2.0:
            continue
        results.append({
            "word": word,
            "this_week": this_count,
            "avg_per_week": avg_per_week,
            "growth_rate": growth_rate,
            "is_new": is_new,
        })
    results.sort(key=lambda x: x["growth_rate"], reverse=True)
    return results[:10]


@router.get("/api/stats/hourly_range")
def stats_hourly_range(start_date: str = Query(default=None), end_date: str = Query(default=None)):
    if not end_date:
        end_date = str(date.today())
    if not start_date:
        start_date = end_date
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT {BUCKET_SQL}, COUNT(*) AS count FROM cs_issues "
            "WHERE date(datetime(created_date, '+9 hours')) BETWEEN ? AND ? GROUP BY bucket",
            (start_date, end_date),
        ).fetchall()
    count_map = {r["bucket"]: r["count"] for r in rows}
    return [{"bucket": b, "count": count_map.get(b, 0)} for b in BUCKETS]


@router.get("/api/stats/daily")
def stats_daily(target_date: str = Query(default=None), period: str = "week"):
    if not target_date:
        target_date = str(date.today())
    where, params = _period_where(target_date, period)
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT date(datetime(created_date, '+9 hours')) AS day,
                   COUNT(*) AS count
            FROM cs_issues WHERE {where}
            GROUP BY day ORDER BY day
            """,
            params,
        ).fetchall()
    return [{"date": r["day"], "count": r["count"]} for r in rows]


@router.get("/api/stats/category")
def stats_category(
    target_date: str = Query(default=None),
    period: str = "day",
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
    bucket: str = Query(default=None),
    q: str = Query(default=None),
):
    if start_date and end_date:
        col = "date(datetime(created_date, '+9 hours'))"
        where, params = f"{col} BETWEEN ? AND ?", [start_date, end_date]
    else:
        if not target_date:
            target_date = str(date.today())
        where, params = _period_where(target_date, period)
    if bucket:
        buckets_list = [b.strip() for b in bucket.split(',') if b.strip()]
        if buckets_list:
            bw, bp = _buckets_where(buckets_list)
            where += f" AND {bw}"
            params.extend(bp)
    if q:
        where += " AND (call_memo LIKE ? OR student_id LIKE ? OR CAST(parent_id AS TEXT) LIKE ?)"
        like = f"%{q}%"
        params.extend([like, like, like])
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT new_category_main, new_category_sub, COUNT(*) AS count
            FROM cs_issues WHERE {where}
            GROUP BY new_category_main, new_category_sub
            ORDER BY new_category_main, count DESC
            """,
            params,
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/api/stats/weekly")
def stats_weekly(target_date: str = Query(default=None)):
    if not target_date:
        target_date = str(date.today())
    range_start, range_end = _four_week_range(target_date)
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT
                date(
                    datetime(created_date, '+9 hours'),
                    '-' || ((strftime('%w', datetime(created_date, '+9 hours')) + 6) % 7) || ' days'
                ) AS week_start,
                COUNT(*) AS count
            FROM cs_issues
            WHERE date(datetime(created_date, '+9 hours')) BETWEEN ? AND ?
            GROUP BY week_start
            ORDER BY week_start
            """,
            (range_start, range_end),
        ).fetchall()
    return [{"week_start": r["week_start"], "count": r["count"]} for r in rows]


@router.get("/api/stats/monthly")
def stats_monthly(target_date: str = Query(default=None)):
    if not target_date:
        target_date = str(date.today())
    d = date.fromisoformat(target_date)
    target_ym = d.strftime('%Y-%m')
    m, y = d.month - 2, d.year
    if m <= 0:
        m += 12
        y -= 1
    start_ym = f"{y:04d}-{m:02d}"
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT strftime('%Y-%m', datetime(created_date, '+9 hours')) AS month,
                   COUNT(*) AS count
            FROM cs_issues
            WHERE strftime('%Y-%m', datetime(created_date, '+9 hours')) BETWEEN ? AND ?
            GROUP BY month
            ORDER BY month
            """,
            (start_ym, target_ym),
        ).fetchall()
    return [{"month": r["month"], "count": r["count"]} for r in rows]


@router.get("/api/stats/category_daily")
def stats_category_daily(target_date: str = Query(default=None)):
    """최근 4주 범위의 일별·카테고리별 건수. (일별 SQI 계산용)
    - new_category_main이 NULL인 행도 포함하므로 하루 전체 합 = 그날 전체 CS 건수.
    - 주말·공휴일 인입은 제외한다 (정책 6: 인입이 거의 없는 날은 비율 통계를 왜곡)."""
    if not target_date:
        target_date = str(date.today())
    range_start, range_end = _four_week_range(target_date)
    kst = "datetime(created_date, '+9 hours')"
    col = f"date({kst})"
    start = date.fromisoformat(range_start)
    end = date.fromisoformat(range_end)
    off_days = [
        str(start + timedelta(days=i))
        for i in range((end - start).days + 1)
        if is_off_day(str(start + timedelta(days=i)))
    ]
    off_clause = f"AND {col} NOT IN ({','.join('?' for _ in off_days)})" if off_days else ""
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT {col} AS day, new_category_main AS main, new_category_sub AS sub, COUNT(*) AS count
            FROM cs_issues
            WHERE {col} BETWEEN ? AND ?
              {off_clause}
            GROUP BY day, main, sub
            ORDER BY day
            """,
            (range_start, range_end, *off_days),
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/api/stats/keyword_trend")
def stats_keyword_trend(target_date: str = Query(default=None)):
    """call_memo에서 한국어 명사를 추출해 이번 주 급증 키워드 TOP 10을 반환한다.

    이번 주: target_date가 속한 주의 월요일 ~ target_date
    직전 4주: 이번 주 월요일 - 28일 ~ 이번 주 월요일 - 1일
    증가율 = 이번주_빈도 / max(직전4주_주당평균, 1)
    신규 = 직전 4주 동안 0회 등장한 단어
    이번 주 최소 3건 이상인 단어만 포함.

    형태소 분석은 처음 호출 시 최대 30초 소요. 결과는 insights_cache에 당일 유효로 저장.
    반환: [{"word", "this_week", "avg_per_week", "growth_rate", "is_new"}, ...]
    """
    if not target_date:
        target_date = str(date.today())

    cache_key = f"keyword_trend:{target_date}"
    with get_conn() as conn:
        cached = conn.execute(
            "SELECT data FROM insights_cache WHERE key = ?", (cache_key,)
        ).fetchone()
    if cached:
        return json.loads(cached["data"])

    d = date.fromisoformat(target_date)
    this_week_monday = d - timedelta(days=d.weekday())
    prior_start = this_week_monday - timedelta(days=28)
    prior_end = this_week_monday - timedelta(days=1)

    # 기기·네트워크 오류 카테고리만 대상 — 해지/미납 메모는 CS 이슈 키워드보다 생활 문맥어가 많아 노이즈 원인
    risk_clause = f"new_category_main IN ({','.join('?' for _ in RISK_MAIN)})"
    risk_params = list(RISK_MAIN)

    col = "date(datetime(created_date, '+9 hours'))"
    base_filter = (
        f"call_memo IS NOT NULL AND call_memo != '' AND parent_id != '92' "
        f"AND call_memo NOT LIKE '%도서증정%' AND call_memo NOT LIKE '%추가배송품목%' "
        f"AND {risk_clause}"
    )
    with get_conn() as conn:
        this_week_rows = conn.execute(
            f"SELECT call_memo, parent_id FROM issues "
            f"WHERE {col} BETWEEN ? AND ? AND {base_filter}",
            (str(this_week_monday), target_date, *risk_params),
        ).fetchall()
        prior_rows = conn.execute(
            f"SELECT call_memo, parent_id, {col} AS day FROM issues "
            f"WHERE {col} BETWEEN ? AND ? AND {base_filter}",
            (str(prior_start), str(prior_end), *risk_params),
        ).fetchall()

    # 이번 주 단어별 고유 학부모 수 — 같은 주에 동일 parent_id가 같은 키워드를 여러 번 언급해도 1건
    this_week_counts: dict[str, int] = {}
    this_week_seen: dict[str, set] = defaultdict(set)
    for nouns, pid in zip(extract_nouns_batch([r["call_memo"] for r in this_week_rows]),
                          [r["parent_id"] for r in this_week_rows]):
        for word in nouns:
            if pid not in this_week_seen[word]:
                this_week_seen[word].add(pid)
                this_week_counts[word] = this_week_counts.get(word, 0) + 1

    # 직전 4주 단어별 주당 고유 학부모 수
    prior_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    prior_seen: dict[str, dict[str, set]] = defaultdict(lambda: defaultdict(set))
    for nouns, pid, day_str in zip(extract_nouns_batch([r["call_memo"] for r in prior_rows]),
                                   [r["parent_id"] for r in prior_rows],
                                   [r["day"] for r in prior_rows]):
        day = date.fromisoformat(day_str)
        week_start = str(day - timedelta(days=day.weekday()))
        for word in nouns:
            if pid not in prior_seen[word][week_start]:
                prior_seen[word][week_start].add(pid)
                prior_counts[word][week_start] += 1

    top10 = compute_keyword_trend(this_week_counts, prior_counts)

    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO insights_cache (key, data, updated_at) "
            "VALUES (?, ?, datetime('now'))",
            (cache_key, json.dumps(top10, ensure_ascii=False)),
        )
        conn.commit()

    return top10


@router.get("/api/stats/keyword_memos")
def stats_keyword_memos(keyword: str = Query(...), target_date: str = Query(default=None)):
    """이번 주 call_memo 중 keyword를 포함하는 메모 목록을 반환한다.
    LIKE 문자열 매칭 대신 형태소 분석으로 필터링해 keyword_trend 집계와 동일한 기준을 적용한다.
    (예: '플루'가 집계됐을 때 원문에 '인플루언서'가 있는 메모를 올바르게 반환)"""
    if not target_date:
        target_date = str(date.today())
    d = date.fromisoformat(target_date)
    this_week_monday = d - timedelta(days=d.weekday())
    col = "date(datetime(created_date, '+9 hours'))"
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT call_memo, {col} AS day FROM issues "
            f"WHERE {col} BETWEEN ? AND ? AND parent_id != '92' AND call_memo NOT LIKE '%도서증정%' AND call_memo NOT LIKE '%추가배송품목%'",
            (str(this_week_monday), target_date),
        ).fetchall()
    if not rows:
        return []
    memos = [r["call_memo"] or "" for r in rows]
    noun_sets = extract_nouns_batch(memos)
    return [
        {"memo": rows[i]["call_memo"], "date": rows[i]["day"]}
        for i, nouns in enumerate(noun_sets)
        if keyword in nouns
    ]


# ── 키워드 탐지 이력 헬퍼 ────────────────────────────────────────────────────────


def _load_keyword_cache_entries(days: int) -> list:
    """최근 N일치 keyword_trend 캐시 항목을 [(date_str, rows), ...] 형태로 반환한다.
    key 형식: keyword_trend:YYYY-MM-DD. SUBSTR(key, 15)로 날짜 부분을 추출한다."""
    cutoff = str(date.today() - timedelta(days=days))
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT key, data FROM insights_cache "
            "WHERE key LIKE 'keyword_trend:%' AND SUBSTR(key, 15) >= ? "
            "ORDER BY key ASC",
            (cutoff,),
        ).fetchall()
    result = []
    for r in rows:
        date_str = r["key"][14:]  # "keyword_trend:" = 14자
        try:
            result.append((date_str, json.loads(r["data"])))
        except Exception:
            pass
    return result


def _compute_auto_status(detected_dates: list, today: date, counts_by_date: dict | None = None) -> str:
    """탐지된 날짜 목록(YYYY-MM-DD 문자열)으로 자동 상태를 계산한다.
    우선순위: 일회성 탐지 > 지속 탐지 > 재탐지 > 신규 탐지 > 감소 추세 > 최근 미탐지
    counts_by_date: {date_str: this_week_count} — 감소 추세 판별에 사용 (없으면 판별 생략)"""
    if not detected_dates:
        return "최근 미탐지"
    sorted_dates = sorted(detected_dates)
    total_days = len(sorted_dates)
    recent_7 = [d for d in sorted_dates if (today - date.fromisoformat(d)).days <= 7]

    if total_days == 1:
        return "일회성 탐지"

    if len(recent_7) >= 2:
        return "지속 탐지"

    if recent_7:
        prev = [d for d in sorted_dates if d < recent_7[0]]
        if prev and (date.fromisoformat(recent_7[0]) - date.fromisoformat(prev[-1])).days >= 7:
            return "재탐지"
        return "신규 탐지"

    # 최근 탐지 없음 — 실제 건수가 연속 감소한 경우에만 감소 추세
    if counts_by_date and total_days >= 3:
        last_3 = sorted_dates[-3:]
        c = [counts_by_date.get(d, 0) for d in last_3]
        if c[0] > c[1] > c[2]:
            return "감소 추세"

    return "최근 미탐지"


@router.get("/api/stats/keyword_history")
def stats_keyword_history(days: int = Query(default=30)):
    """최근 N일치 keyword_trend 캐시를 읽어 키워드 단위로 집계한다.
    각 항목: word, first_detected, last_detected, peak_date, peak_count, peak_growth,
             latest_count, latest_growth, detection_days, recent_detection_days, auto_status.
    정렬: 자동 상태 우선순위 → peak_growth 내림차순."""
    entries = _load_keyword_cache_entries(days)
    today = date.today()

    agg = defaultdict(lambda: {
        "detected_dates": [],
        "counts_by_date": {},
        "peak_count": 0, "peak_growth": 0.0, "peak_date": None,
        "latest_count": 0, "latest_growth": 0.0,
    })

    for date_str, rows in entries:
        for row in rows:
            word = row.get("word", "")
            if not word:
                continue
            e = agg[word]
            e["detected_dates"].append(date_str)
            this_week = row.get("this_week", 0)
            growth = row.get("growth_rate", 0.0)
            e["counts_by_date"][date_str] = this_week
            if this_week > e["peak_count"]:
                e["peak_count"] = this_week
                e["peak_growth"] = growth
                e["peak_date"] = date_str
            e["latest_count"] = this_week
            e["latest_growth"] = growth

    STATUS_ORDER = {"지속 탐지": 0, "재탐지": 1, "신규 탐지": 2, "최근 미탐지": 3, "일회성 탐지": 4, "감소 추세": 5}
    result = []
    for word, data in agg.items():
        sorted_dates = sorted(data["detected_dates"])
        recent_7_count = sum(1 for d in sorted_dates if (today - date.fromisoformat(d)).days <= 7)
        auto_status = _compute_auto_status(sorted_dates, today, data["counts_by_date"])
        result.append({
            "word": word,
            "first_detected": sorted_dates[0],
            "last_detected": sorted_dates[-1],
            "peak_date": data["peak_date"],
            "peak_count": data["peak_count"],
            "peak_growth": round(data["peak_growth"], 1),
            "latest_count": data["latest_count"],
            "latest_growth": round(data["latest_growth"], 1),
            "detection_days": len(sorted_dates),
            "recent_detection_days": recent_7_count,
            "auto_status": auto_status,
        })

    result.sort(key=lambda x: (STATUS_ORDER.get(x["auto_status"], 9), -x["peak_growth"]))
    return result


@router.get("/api/stats/keyword_trend_dates")
def stats_keyword_trend_dates(keyword: str = Query(...), days: int = Query(default=30)):
    """특정 키워드의 날짜별 탐지 이력을 반환한다 (키워드 상세 흐름 차트용).
    탐지된 날짜만 포함되며, 없는 날짜는 제외된다 (캐시 미존재 = 탐지 기준 미충족 또는 미수집).
    최신 날짜 순 정렬."""
    entries = _load_keyword_cache_entries(days)
    result = []
    for date_str, rows in entries:
        for row in rows:
            if row.get("word") == keyword:
                result.append({
                    "date": date_str,
                    "this_week": row.get("this_week", 0),
                    "avg_per_week": round(row.get("avg_per_week", 0.0), 1),
                    "growth_rate": round(row.get("growth_rate", 0.0), 1),
                    "is_new": row.get("is_new", False),
                })
                break
    result.sort(key=lambda x: x["date"], reverse=True)
    return result
