# 통계 집계 API 라우터 (8개 엔드포인트). 모두 GET 요청이며 쿼리 파라미터로 기간을 지정한다.
# hourly_range  : 날짜 범위의 30분 버킷별 건수 반환 — 차트 X축 26개 버킷 고정 출력.
# daily         : 일별 건수 (period=day/week/month).
# category      : 대분류·소분류·버킷 조합 필터 집계 — 카테고리 드릴다운용.
# weekly        : 주차별 건수 (최근 4주). monthly : 월별 건수 (최근 3개월).
# category_daily: 최근 4주 일별·카테고리별 건수, 주말·공휴일 제외 — 일별 SQI 계산용.
# keyword_trend : call_memo 한국어 명사 중 이번 주 급증 키워드 TOP 10 — 미지의 버그 탐지기용.
#                 kiwipiepy로 형태소 분석, 결과를 insights_cache에 캐시한다 (당일 유효).
# keyword_memos : 이번 주 call_memo 중 특정 keyword를 포함하는 메모 목록 — 키워드 클릭 시 팝업용.
import json
from datetime import date, timedelta
from fastapi import APIRouter, Query
from core.db import get_conn
from core.date_bucket_utils import BUCKET_SQL, BUCKETS, _bucket_where, _period_where, _four_week_range
from core.holidays import is_off_day

router = APIRouter()

# CS 메모에서 항상 등장하지만 트렌드 분석 가치가 없는 일반 관리 용어 및 서비스 고유 명사.
# keyword_trend 결과에서 이 단어들은 제외한다.
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
    반환: 입력 리스트와 같은 길이의 set 리스트. 각 set은 해당 메모의 NNG 명사 집합."""
    kiwi = _get_kiwi()
    results = []
    for analysis in kiwi.analyze(texts):
        # analyze() → [(token_list, score), ...]; [0][0]이 최적 분석 결과의 토큰 리스트
        nouns = {
            tok.form for tok in analysis[0][0]
            if tok.tag == 'NNG' and len(tok.form) >= 2 and tok.form not in CS_STOP_WORDS
        }
        results.append(nouns)
    return results


def compute_keyword_trend(this_week_counts: dict, prior_counts: dict) -> list:
    """집계된 단어 빈도로 이번 주 급증 키워드 TOP 10을 계산한다 (순수 함수, DB·형태소 분석과 분리).

    this_week_counts: {단어: 이번주 포함 메모 수}
    prior_counts:     {단어: {주차 월요일: 해당 주 포함 메모 수}}  (직전 4주)

    증가율 = 이번주_빈도 / max(직전4주_주당평균, 1)
    신규   = 직전 4주 동안 0회 등장
    이번 주 최소 3건 이상인 단어만 포함하며, 증가율 내림차순 TOP 10을 반환한다.
    반환: [{"word", "this_week", "avg_per_week", "growth_rate", "is_new"}, ...]"""
    results = []
    for word, this_count in this_week_counts.items():
        if this_count < 3:
            continue
        prior_total = sum(prior_counts[word].values()) if word in prior_counts else 0
        avg_per_week = round(prior_total / 4, 1)
        is_new = prior_total == 0
        growth_rate = round(this_count / max(avg_per_week, 1), 1)
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
            f"SELECT {BUCKET_SQL}, COUNT(*) AS count FROM issues "
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
            FROM issues WHERE {where}
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
):
    if start_date and end_date:
        col = "date(datetime(created_date, '+9 hours'))"
        where, params = f"{col} BETWEEN ? AND ?", [start_date, end_date]
    else:
        if not target_date:
            target_date = str(date.today())
        where, params = _period_where(target_date, period)
    if bucket:
        bw, bp = _bucket_where(bucket)
        where += f" AND {bw}"
        params.extend(bp)
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT new_category_main, new_category_sub, COUNT(*) AS count
            FROM issues WHERE {where}
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
            FROM issues
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
            FROM issues
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
            FROM issues
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

    col = "date(datetime(created_date, '+9 hours'))"
    with get_conn() as conn:
        this_week_rows = conn.execute(
            f"SELECT call_memo FROM issues "
            f"WHERE {col} BETWEEN ? AND ? AND call_memo IS NOT NULL AND call_memo != ''",
            (str(this_week_monday), target_date),
        ).fetchall()
        prior_rows = conn.execute(
            f"SELECT call_memo, {col} AS day FROM issues "
            f"WHERE {col} BETWEEN ? AND ? AND call_memo IS NOT NULL AND call_memo != ''",
            (str(prior_start), str(prior_end)),
        ).fetchall()

    # 이번 주 단어별 포함 메모 수 (메모 단위 중복 제거) — 배치 분석
    this_week_counts: dict[str, int] = {}
    this_week_memos = [row["call_memo"] for row in this_week_rows]
    for nouns in extract_nouns_batch(this_week_memos):
        for word in nouns:
            this_week_counts[word] = this_week_counts.get(word, 0) + 1

    # 직전 4주 단어별 주당 포함 메모 수 — 배치 분석
    from collections import defaultdict
    prior_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    prior_memos = [row["call_memo"] for row in prior_rows]
    prior_days = [row["day"] for row in prior_rows]
    for nouns, day_str in zip(extract_nouns_batch(prior_memos), prior_days):
        day = date.fromisoformat(day_str)
        week_start = str(day - timedelta(days=day.weekday()))
        for word in nouns:
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
    """이번 주 call_memo 중 keyword를 포함하는 메모 목록을 반환한다."""
    if not target_date:
        target_date = str(date.today())
    d = date.fromisoformat(target_date)
    this_week_monday = d - timedelta(days=d.weekday())
    col = "date(datetime(created_date, '+9 hours'))"
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT call_memo, {col} AS day FROM issues "
            f"WHERE {col} BETWEEN ? AND ? AND call_memo LIKE ?",
            (str(this_week_monday), target_date, f'%{keyword}%'),
        ).fetchall()
    return [{"memo": r["call_memo"], "date": r["day"]} for r in rows]
