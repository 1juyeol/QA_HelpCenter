# -*- coding: utf-8 -*-
# features/mailer/weekly_report_mailer.py의 _week_label() 유닛 테스트.
# 월/주차를 세는 방식은 frontend/src/pages/report/WeeklyReport.tsx의 getWeekLabel()과 반드시
# 같아야 하는 함수라, 같은 테스트 케이스(2026-08-17 -> 8월 3주차, 2026-08-24 -> 8월 4주차)에
# 연도만 붙여 대응시켰다(메일은 화면과 달리 맥락 없이 단독으로 보이므로 연도 표기가 필요하다).
# DB 조회 없이 실행 가능.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from features.mailer.weekly_report_mailer import _week_label


class TestWeekLabel:
    def test_8월_3주차(self):
        assert _week_label("2026-08-17") == "2026년 8월 3주차"

    def test_8월_4주차(self):
        assert _week_label("2026-08-24") == "2026년 8월 4주차"

    def test_월초_1주차(self):
        assert _week_label("2026-08-03") == "2026년 8월 1주차"
