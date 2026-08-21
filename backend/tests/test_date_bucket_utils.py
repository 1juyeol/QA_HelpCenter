# core/date_bucket_utils.py 유닛 테스트.
# _four_week_range: 날짜 경계 및 요일별 월요일 앵커 계산 검증.
# _period_where: day/week/month 각 모드의 WHERE 조건 및 파라미터 검증.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.date_bucket_utils import _four_week_range, _period_where


class TestFourWeekRange:
    def test_monday_input(self):
        # 월요일 입력 → 그 주 월요일이 앵커
        start, end = _four_week_range('2025-06-09')  # 월요일
        assert start == '2025-05-19'  # 3주 전 월요일
        assert end   == '2025-06-15'  # 해당 주 일요일

    def test_wednesday_input(self):
        # 수요일 입력 → 해당 주 월요일이 앵커
        start, end = _four_week_range('2025-06-11')  # 수요일
        assert start == '2025-05-19'
        assert end   == '2025-06-15'

    def test_sunday_input(self):
        # 일요일 입력 → 해당 주 월요일이 앵커
        start, end = _four_week_range('2025-06-15')  # 일요일
        assert start == '2025-05-19'
        assert end   == '2025-06-15'

    def test_year_boundary(self):
        # 연초 경계: 1월 첫 주
        start, end = _four_week_range('2025-01-06')  # 월요일
        assert start == '2024-12-16'
        assert end   == '2025-01-12'

    def test_range_is_28_days(self):
        # 범위는 항상 28일(4주)
        from datetime import date
        start, end = _four_week_range('2025-06-12')
        delta = date.fromisoformat(end) - date.fromisoformat(start)
        assert delta.days == 27  # start~end 포함 28일 = 27일 차이


class TestPeriodWhere:
    def test_day_mode(self):
        where, params = _period_where('2025-06-12', 'day')
        assert '= ?' in where
        assert params == ['2025-06-12']

    def test_week_mode(self):
        where, params = _period_where('2025-06-12', 'week')
        assert 'BETWEEN' in where
        assert params[0] == '2025-06-06'  # 6일 전
        assert params[1] == '2025-06-12'

    def test_month_mode(self):
        where, params = _period_where('2025-06-12', 'month')
        assert 'BETWEEN' in where
        assert params[0] == '2025-06-01'
        assert params[1] == '2025-06-12'

    def test_unknown_mode_returns_noop(self):
        where, params = _period_where('2025-06-12', 'unknown')
        assert where == '1=1'
        assert params == []
