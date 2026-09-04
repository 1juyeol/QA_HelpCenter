# -*- coding: utf-8 -*-
# 통계 집계 API 라우터 (6개 엔드포인트). 모두 GET 요청이며 쿼리 파라미터로 기간을 지정한다.
# hourly_range       : 날짜 범위의 30분 버킷별 건수 반환 — 차트 X축 26개 버킷 고정 출력.
# daily              : 일별 건수 (period=day/week/month).
# category           : 대분류·소분류·버킷 조합 필터 집계 — 카테고리 드릴다운용.
# weekly             : 주차별 건수 (최근 4주). monthly : 월별 건수 (최근 3개월).
# category_daily     : 최근 4주 일별·카테고리별 건수, 주말·공휴일 제외 — 일별 SQI 계산용.
#
# hourly_range/daily/category/weekly/monthly는 include_system_batches=true 쿼리 파라미터를
# 받는다 — 기본값(false)은 지금까지처럼 cs_issues(추가배송·재가입선물 등 백엔드 개발자가
# 일괄로 수천~수만 건씩 밀어넣는 시스템 자동 이력을 제외한 뷰)를 쓴다. 운영 현황
# 대시보드(Dashboard.tsx)만 이 값을 true로 넘겨 원본 issues 테이블을 그대로 본다 — 운영
# 현황은 "실제 CS 업무량"이 아니라 "시스템에 지금 뭐가 쌓이고 있는지" 있는 그대로 보여주는
# 화면이라는 취지라, 일별/주간 보고서·인사이트 페이지들과는 다르게 걸러내지 않기로 했다.
# category_daily(SQI 계산 전용)는 운영 현황이 쓰지 않아 이 옵션이 없다.
from datetime import date, timedelta
from fastapi import APIRouter, Query
from core.db import get_conn
from core.date_bucket_utils import BUCKET_SQL, BUCKETS, _buckets_where, _period_where, _four_week_range
from core.holidays import is_off_day

router = APIRouter()


def _issues_table(include_system_batches: bool) -> str:
    return "issues" if include_system_batches else "cs_issues"


@router.get("/api/stats/hourly_range")
def stats_hourly_range(
    start_date: str = Query(default=None), end_date: str = Query(default=None),
    include_system_batches: bool = False,
):
    if not end_date:
        end_date = str(date.today())
    if not start_date:
        start_date = end_date
    table = _issues_table(include_system_batches)
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT {BUCKET_SQL}, COUNT(*) AS count FROM {table} "
            "WHERE date(datetime(created_date, '+9 hours')) BETWEEN ? AND ? GROUP BY bucket",
            (start_date, end_date),
        ).fetchall()
    count_map = {r["bucket"]: r["count"] for r in rows}
    return [{"bucket": b, "count": count_map.get(b, 0)} for b in BUCKETS]


@router.get("/api/stats/daily")
def stats_daily(target_date: str = Query(default=None), period: str = "week", include_system_batches: bool = False):
    if not target_date:
        target_date = str(date.today())
    where, params = _period_where(target_date, period)
    table = _issues_table(include_system_batches)
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT date(datetime(created_date, '+9 hours')) AS day,
                   COUNT(*) AS count
            FROM {table} WHERE {where}
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
    include_system_batches: bool = False,
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
    table = _issues_table(include_system_batches)
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT new_category_main, new_category_sub, COUNT(*) AS count
            FROM {table} WHERE {where}
            GROUP BY new_category_main, new_category_sub
            ORDER BY new_category_main, count DESC
            """,
            params,
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/api/stats/weekly")
def stats_weekly(target_date: str = Query(default=None), include_system_batches: bool = False):
    if not target_date:
        target_date = str(date.today())
    range_start, range_end = _four_week_range(target_date)
    table = _issues_table(include_system_batches)
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT
                date(
                    datetime(created_date, '+9 hours'),
                    '-' || ((strftime('%w', datetime(created_date, '+9 hours')) + 6) % 7) || ' days'
                ) AS week_start,
                COUNT(*) AS count
            FROM {table}
            WHERE date(datetime(created_date, '+9 hours')) BETWEEN ? AND ?
            GROUP BY week_start
            ORDER BY week_start
            """,
            (range_start, range_end),
        ).fetchall()
    return [{"week_start": r["week_start"], "count": r["count"]} for r in rows]


@router.get("/api/stats/monthly")
def stats_monthly(target_date: str = Query(default=None), include_system_batches: bool = False):
    if not target_date:
        target_date = str(date.today())
    d = date.fromisoformat(target_date)
    target_ym = d.strftime('%Y-%m')
    m, y = d.month - 3, d.year
    if m <= 0:
        m += 12
        y -= 1
    start_ym = f"{y:04d}-{m:02d}"
    table = _issues_table(include_system_batches)
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT strftime('%Y-%m', datetime(created_date, '+9 hours')) AS month,
                   COUNT(*) AS count
            FROM {table}
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
