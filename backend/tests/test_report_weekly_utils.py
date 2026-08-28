# -*- coding: utf-8 -*-
# features/report/report_weekly.py 의 순수 유틸 함수 단위 테스트.
# 테스트 대상: _fmt_date_ko, _weighted_sample_memos, _extract_top_keywords, _classify_wings_repeat
# DB·Gemma 의존 없이 실행 가능 (import 시 연결하지 않고 호출 시점에 연결하는 구조).
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from features.report.report_weekly import (
    _fmt_date_ko,
    _weighted_sample_memos,
    _extract_top_keywords,
    _classify_wings_repeat,
)


class TestFmtDateKo:
    def test_monday(self):
        assert _fmt_date_ko('2026-06-15') == '06/15(월)'

    def test_wednesday(self):
        assert _fmt_date_ko('2026-06-17') == '06/17(수)'

    def test_sunday(self):
        assert _fmt_date_ko('2026-06-21') == '06/21(일)'

    def test_year_boundary(self):
        # 2026-01-01은 목요일
        assert _fmt_date_ko('2026-01-01') == '01/01(목)'

    def test_separator_replaced(self):
        # '-' → '/' 변환 확인
        result = _fmt_date_ko('2026-03-09')
        assert '-' not in result.split('(')[0]
        assert '03/09' in result


class TestWeightedSampleMemos:
    def _make_memos(self, date: str, n: int) -> list:
        return [{"date": date, "text": f"메모{i}"} for i in range(n)]

    def test_empty(self):
        result, peak_day, peak_count = _weighted_sample_memos([])
        assert result == []
        assert peak_day == ""
        assert peak_count == 0

    def test_under_max_returns_all(self):
        memos = self._make_memos('2026-06-15', 10)
        result, peak_day, peak_count = _weighted_sample_memos(memos, max_count=40)
        assert len(result) == 10
        assert peak_count == 10
        assert '06/15(월)' in peak_day

    def test_exactly_max_returns_all(self):
        memos = self._make_memos('2026-06-16', 40)
        result, _, _ = _weighted_sample_memos(memos, max_count=40)
        assert len(result) == 40

    def test_over_max_proportional_sampling(self):
        # A: 30개, B: 20개, C: 10개 → 총 60개, max=20
        memos = (
            self._make_memos('2026-06-15', 30) +
            self._make_memos('2026-06-16', 20) +
            self._make_memos('2026-06-17', 10)
        )
        result, peak_day, peak_count = _weighted_sample_memos(memos, max_count=20)
        assert len(result) <= 20
        assert peak_count == 30
        assert '06/15(월)' in peak_day

    def test_peak_is_max_day(self):
        # 화요일(16일)이 가장 많아야 피크
        memos = self._make_memos('2026-06-15', 5) + self._make_memos('2026-06-16', 20)
        _, peak_day, peak_count = _weighted_sample_memos(memos)
        assert peak_count == 20
        assert '06/16(화)' in peak_day

    def test_two_days_both_included(self):
        # 2일 데이터 균등 → max 내에서 양쪽 모두 포함
        memos = self._make_memos('2026-06-15', 10) + self._make_memos('2026-06-16', 10)
        result, _, _ = _weighted_sample_memos(memos, max_count=12)
        dates_in_result = {m["date"] for m in result}
        assert '2026-06-15' in dates_in_result
        assert '2026-06-16' in dates_in_result


class TestExtractTopKeywords:
    def test_empty(self):
        assert _extract_top_keywords([]) == []

    def test_basic_frequency(self):
        # '앱'은 1글자라 [가-힣]{2,6} 미매칭 — 2글자 이상 단어로 테스트
        texts = ['결제 오류 발생', '결제 오류 문의', '결제 문의']
        result = _extract_top_keywords(texts)
        # '결제'(3회), '오류'(2회), '발생'(1회), '문의'는 stopword 제외
        assert result[0] == '결제'
        assert '오류' in result

    def test_stopwords_excluded(self):
        # '문의', '확인', '처리'는 _KW_STOPWORDS에 포함
        texts = ['문의 확인 처리 완료', '문의 처리 중']
        result = _extract_top_keywords(texts)
        assert '문의' not in result
        assert '확인' not in result
        assert '처리' not in result

    def test_non_korean_excluded(self):
        texts = ['WiFi error 발생', 'iOS 앱 오류']
        result = _extract_top_keywords(texts)
        assert 'WiFi' not in result
        assert 'error' not in result
        assert 'iOS' not in result

    def test_short_word_excluded(self):
        # 1글자 한글은 패턴 [가-힣]{2,6}에 매칭 안 됨
        texts = ['앱 오류 나 좀 봐']
        result = _extract_top_keywords(texts)
        assert '나' not in result
        assert '봐' not in result

    def test_top_n_limit(self):
        texts = [f'단어{i} 단어{i} 단어{i}' for i in range(20)]
        result = _extract_top_keywords(texts, top_n=5)
        assert len(result) <= 5

    def test_frequency_ordering(self):
        texts = ['해지 해지 해지', '오류 오류', '결제']
        result = _extract_top_keywords(texts)
        assert result.index('해지') < result.index('오류')
        assert result.index('오류') < result.index('결제')


class TestClassifyWingsRepeat:
    WEEK_START = '2026-08-24'
    WEEK_END = '2026-08-30'

    def _ticket(self, first_date):
        return {"ticket_id": "1", "first_date": first_date}

    def test_empty_list(self):
        result = _classify_wings_repeat([], self.WEEK_START, self.WEEK_END)
        assert result == {"new_count": 0, "stale_count": 0}

    def test_first_date_within_week_is_new(self):
        tickets = [self._ticket('2026-08-26 00:00:00')]
        result = _classify_wings_repeat(tickets, self.WEEK_START, self.WEEK_END)
        assert result == {"new_count": 1, "stale_count": 0}

    def test_first_date_before_week_is_stale(self):
        tickets = [self._ticket('2026-07-01 00:00:00')]
        result = _classify_wings_repeat(tickets, self.WEEK_START, self.WEEK_END)
        assert result == {"new_count": 0, "stale_count": 1}

    def test_week_boundaries_monday_sunday_are_new(self):
        tickets = [self._ticket('2026-08-24 09:00:00'), self._ticket('2026-08-30 23:59:00')]
        result = _classify_wings_repeat(tickets, self.WEEK_START, self.WEEK_END)
        assert result == {"new_count": 2, "stale_count": 0}

    def test_first_date_after_week_end_ignored(self):
        tickets = [self._ticket('2026-09-05 00:00:00')]
        result = _classify_wings_repeat(tickets, self.WEEK_START, self.WEEK_END)
        assert result == {"new_count": 0, "stale_count": 0}

    def test_mixed_new_and_stale(self):
        tickets = [
            self._ticket('2026-08-26 00:00:00'),
            self._ticket('2026-07-01 00:00:00'),
            self._ticket('2026-07-05 00:00:00'),
        ]
        result = _classify_wings_repeat(tickets, self.WEEK_START, self.WEEK_END)
        assert result == {"new_count": 1, "stale_count": 2}
