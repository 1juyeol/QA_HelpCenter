# -*- coding: utf-8 -*-
# 영업일 판단 유틸리티. 주말·공휴일 제외가 필요한 통계 계산에 사용한다.
#
# 제공 함수:
#   is_holiday(date_str)  : 공휴일 여부 (법정공휴일 + 임시공휴일). 주말은 포함하지 않는다.
#   is_off_day(date_str)  : 통계 제외 대상 여부 — 주말 또는 공휴일이면 True.
#   previous_business_day(date_str) : date_str 하루 전부터 거슬러 올라가 처음 만나는 영업일.
#
# 법정공휴일(대체공휴일 포함)은 holidays 패키지가 자동 처리한다.
# 선거일 등 임시공휴일은 _EXTRA_HOLIDAYS에 수동 추가한다.
#
# 사용처: report_weekly.py (KPI 집계), stats_endpoints.py (SQI 계산), report_daily.py (피크타임 평균)
# 의존: holidays 패키지 (requirements.txt)

import holidays as _holidays_lib
from datetime import date, timedelta
from functools import lru_cache

# holidays 패키지가 인식하지 못하는 임시공휴일 (선거일, 특별공휴일 등)
# 새 임시공휴일이 생기면 여기에만 추가한다.
_EXTRA_HOLIDAYS = {
    "2026-06-03",  # 제8회 전국동시지방선거
}


@lru_cache(maxsize=10)
def _kr_holidays(year: int):
    return _holidays_lib.KR(years=year)


def is_holiday(date_str: str) -> bool:
    """공휴일 여부. 법정공휴일(대체공휴일 포함) + 임시공휴일. 주말은 포함하지 않는다."""
    return date_str in _kr_holidays(int(date_str[:4])) or date_str in _EXTRA_HOLIDAYS


def is_off_day(date_str: str) -> bool:
    """통계 제외 대상 여부. 주말 또는 공휴일이면 True."""
    d = date.fromisoformat(date_str)
    return d.weekday() >= 5 or is_holiday(date_str)


def previous_business_day(date_str: str) -> str:
    """date_str 하루 전부터 거슬러 올라가 처음 만나는 영업일을 반환한다.
    예: 월요일이면 금요일(주말 건너뜀), 연휴 다음 날이면 연휴 전 영업일."""
    d = date.fromisoformat(date_str) - timedelta(days=1)
    while is_off_day(d.isoformat()):
        d -= timedelta(days=1)
    return d.isoformat()
