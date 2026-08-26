# -*- coding: utf-8 -*-
# core/holidays.py의 previous_business_day() 유닛 테스트.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.holidays import previous_business_day


class TestPreviousBusinessDay:
    def test_weekday_returns_the_day_before(self):
        # 2026-08-25(화)의 전날은 2026-08-24(월), 평일이라 그대로 반환.
        assert previous_business_day("2026-08-25") == "2026-08-24"

    def test_monday_skips_weekend_to_friday(self):
        # 2026-08-24(월)의 전날은 일요일(23일) → 토요일(22일)까지 건너뛰어 금요일(21일).
        assert previous_business_day("2026-08-24") == "2026-08-21"

    def test_day_after_holiday_skips_to_before_holiday(self):
        # 2026-08-16(일)은 광복절(15일, 토) 다음날 — 토요일(15일)이 공휴일+주말이라
        # 더 거슬러 올라가 금요일(14일)이 나와야 한다.
        assert previous_business_day("2026-08-16") == "2026-08-14"
