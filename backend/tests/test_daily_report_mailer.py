# -*- coding: utf-8 -*-
# features/mailer/daily_report_mailer.py의 _date_label() 유닛 테스트.
# DB 조회 없이 실행 가능.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from features.mailer.daily_report_mailer import _date_label


class TestDateLabel:
    def test_formats_with_year_month_day(self):
        assert _date_label("2026-08-24") == "2026년 8월 24일"

    def test_does_not_zero_pad_month_or_day(self):
        assert _date_label("2026-01-05") == "2026년 1월 5일"
