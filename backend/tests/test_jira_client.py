# -*- coding: utf-8 -*-
# features/jira/jira_client.py의 compute_card_counts() 유닛 테스트.
# DB·JIRA API 의존 없이 실행 가능(순수 함수).
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from features.jira.jira_client import compute_card_counts

TODAY = date(2026, 9, 4)


def bug(status="미해결", days_ago=0):
    created = TODAY - timedelta(days=days_ago)
    return {"status": status, "created_at": created.isoformat()}


class TestComputeCardCounts:
    def test_empty_list_returns_all_zero(self):
        assert compute_card_counts([], today=TODAY) == {
            "total_count": 0, "pending_review_count": 0, "six_month_count": 0, "one_year_count": 0,
        }

    def test_total_counts_all_bugs(self):
        bugs = [bug(status="미해결"), bug(status="진행 중"), bug(status="QA확인")]
        assert compute_card_counts(bugs, today=TODAY)["total_count"] == 3

    def test_pending_review_counts_only_미해결_status(self):
        bugs = [bug(status="미해결"), bug(status="검토 중"), bug(status="미해결")]
        assert compute_card_counts(bugs, today=TODAY)["pending_review_count"] == 2

    def test_under_6_months_not_counted(self):
        bugs = [bug(days_ago=179)]
        assert compute_card_counts(bugs, today=TODAY)["six_month_count"] == 0

    def test_exactly_6_months_counted(self):
        bugs = [bug(days_ago=180)]
        assert compute_card_counts(bugs, today=TODAY)["six_month_count"] == 1

    def test_under_1_year_not_counted_in_one_year(self):
        bugs = [bug(days_ago=364)]
        counts = compute_card_counts(bugs, today=TODAY)
        assert counts["six_month_count"] == 1
        assert counts["one_year_count"] == 0

    def test_over_1_year_counted_in_both(self):
        bugs = [bug(days_ago=400)]
        counts = compute_card_counts(bugs, today=TODAY)
        assert counts["six_month_count"] == 1
        assert counts["one_year_count"] == 1

    def test_mixed_bugs_summed_correctly(self):
        bugs = [
            bug(status="미해결", days_ago=10),
            bug(status="검토 중", days_ago=200),
            bug(status="미해결", days_ago=400),
        ]
        counts = compute_card_counts(bugs, today=TODAY)
        assert counts == {
            "total_count": 3, "pending_review_count": 2, "six_month_count": 2, "one_year_count": 1,
        }
