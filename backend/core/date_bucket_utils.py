# -*- coding: utf-8 -*-
# 30분 단위 시간 버킷 정의와 날짜 필터 생성 유틸. stats·issues 라우터가 공통으로 사용한다.
# BUCKET_SQL  : SQL SELECT에 삽입할 시간 버킷 라벨 계산식 (~09:00 / 09:00~09:30 / ... / 21:00~). KST 변환 포함.
# BUCKETS     : 버킷 라벨 순서 목록 — 차트 X축 기준이 되며, DB 결과와 병합 시 0 패딩에 사용한다.
# _bucket_where  : 특정 버킷 하나에 해당하는 WHERE SQL 조건 반환.
# _buckets_where : 복수 버킷에 대한 OR 조건 반환 (다중 시간대 필터 시 사용).
# _period_where  : day/week/month 키워드를 날짜 범위 WHERE SQL 조건으로 변환.
from datetime import date, timedelta

BUCKET_SQL = """
    CASE
        WHEN CAST(strftime('%H', datetime(created_date, '+9 hours')) AS INTEGER) < 9 THEN '~09:00'
        WHEN CAST(strftime('%H', datetime(created_date, '+9 hours')) AS INTEGER) >= 21 THEN '21:00~'
        ELSE strftime('%H', datetime(created_date, '+9 hours')) || ':' ||
             CASE WHEN CAST(strftime('%M', datetime(created_date, '+9 hours')) AS INTEGER) < 30
                  THEN '00' ELSE '30' END
    END AS bucket
"""
BUCKETS = ['~09:00'] + [f"{h:02d}:{m}" for h in range(9, 21) for m in ('00', '30')] + ['21:00~']


def _bucket_where(bucket: str):
    dt = "datetime(created_date, '+9 hours')"
    h = f"CAST(strftime('%H', {dt}) AS INTEGER)"
    m = f"CAST(strftime('%M', {dt}) AS INTEGER)"
    if bucket == '~09:00':
        return f"{h} < 9", []
    if bucket == '21:00~':
        return f"{h} >= 21", []
    hh, mm = bucket.split(':')
    hh = int(hh)
    if mm == '00':
        return f"({h} = {hh} AND {m} < 30)", []
    return f"({h} = {hh} AND {m} >= 30)", []


def _buckets_where(buckets: list):
    if len(buckets) == 1:
        return _bucket_where(buckets[0])
    conditions, params = [], []
    for b in buckets:
        cond, p = _bucket_where(b)
        conditions.append(f"({cond})")
        params.extend(p)
    return "(" + " OR ".join(conditions) + ")", params


def _period_where(target_date: str, period: str):
    d = date.fromisoformat(target_date)
    col = "date(datetime(created_date, '+9 hours'))"
    if period == "day":
        return f"{col} = ?", [target_date]
    elif period == "week":
        start = str(d - timedelta(days=6))
        return f"{col} BETWEEN ? AND ?", [start, target_date]
    elif period == "month":
        start = str(d.replace(day=1))
        return f"{col} BETWEEN ? AND ?", [start, target_date]
    return "1=1", []


def _four_week_range(target_date: str) -> tuple:
    d = date.fromisoformat(target_date)
    monday = d - timedelta(days=d.weekday())
    return str(monday - timedelta(days=21)), str(monday + timedelta(days=6))
