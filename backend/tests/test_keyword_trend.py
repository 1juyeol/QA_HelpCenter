# -*- coding: utf-8 -*-
# features/stats/stats_endpoints.py의 compute_keyword_trend 순수 함수 유닛 테스트.
# compute_keyword_trend: 집계된 단어 빈도(this_week_counts / prior_counts)로
#   이번 주 급증 키워드 TOP 10을 계산하는 순수 함수. DB·형태소 분석과 분리되어 있어
#   증가율 계산·신규 판정·5건 미만/증가율 2.0배 미만 필터(오탐 방지)·정렬·TOP 10 절단 로직만 단독 검증한다.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from features.stats.stats_endpoints import compute_keyword_trend


class TestComputeKeywordTrend:
    def test_min_five_filter(self):
        # 이번 주 5건 미만 단어는 제외된다
        result = compute_keyword_trend({"버퍼링": 4}, {})
        assert result == []

        result = compute_keyword_trend({"버퍼링": 5}, {})
        assert len(result) == 1
        assert result[0]["word"] == "버퍼링"

    def test_min_growth_rate_filter(self):
        # 5건 이상이어도 증가율 2.0배 미만이면 제외된다
        result = compute_keyword_trend(
            {"충전": 5}, {"충전": {"2026-05-04": 3, "2026-05-11": 3, "2026-05-18": 3, "2026-05-25": 3}}
        )
        # avg_per_week=3.0, growth_rate=5/3=1.7 → 2.0 미만이라 제외
        assert result == []

    def test_is_new_flag(self):
        # 직전 4주 0회 등장 → is_new=True
        result = compute_keyword_trend({"끊김": 5}, {})
        assert result[0]["is_new"] is True
        assert result[0]["avg_per_week"] == 0

        # 직전 4주 등장 이력 있음 → is_new=False
        result = compute_keyword_trend(
            {"끊김": 5}, {"끊김": {"2026-05-04": 2, "2026-05-11": 2}}
        )
        assert result[0]["is_new"] is False

    def test_growth_rate_new_word(self):
        # 신규 단어: avg_per_week=0 → max(0,1)=1로 나눠 증가율 = 이번주 건수
        result = compute_keyword_trend({"발열": 7}, {})
        assert result[0]["growth_rate"] == 7.0
        assert result[0]["avg_per_week"] == 0

    def test_growth_rate_existing_word(self):
        # 직전 4주 총 8건 → 주당평균 2.0, 이번주 6건 → 증가율 3.0
        result = compute_keyword_trend(
            {"충전": 6},
            {"충전": {"2026-05-04": 2, "2026-05-11": 2, "2026-05-18": 2, "2026-05-25": 2}},
        )
        assert result[0]["avg_per_week"] == 2.0
        assert result[0]["growth_rate"] == 3.0

    def test_sorted_desc_and_top10(self):
        # 증가율 내림차순 정렬 + 12개 입력 시 TOP 10만 반환
        counts = {f"단어{i}": i + 5 for i in range(12)}  # 5,6,...,16건 (모두 신규, 전부 5건 이상)
        result = compute_keyword_trend(counts, {})
        assert len(result) == 10
        rates = [r["growth_rate"] for r in result]
        assert rates == sorted(rates, reverse=True)
        # 가장 건수 많은 단어11(16건)이 1위
        assert result[0]["word"] == "단어11"
