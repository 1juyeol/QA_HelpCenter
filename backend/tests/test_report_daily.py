# features/report/report_daily.py의 find_anomaly_bucket() 유닛 테스트.
# 피크타임(17~20시) 밖인데 그날 피크타임 최다 버킷보다 인입이 많은 버킷을 찾는 순수 함수.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from features.report.report_daily import find_anomaly_bucket, has_gemma_failures


def _memos(n):
    return [{"id": i, "text": f"메모{i}"} for i in range(n)]


class TestFindAnomalyBucket:
    def test_no_off_peak_buckets_returns_none(self):
        all_bucket_rows = {"17:00": _memos(10), "18:00": _memos(5)}
        assert find_anomaly_bucket(all_bucket_rows, peak_max_count=10) is None

    def test_off_peak_not_exceeding_peak_returns_none(self):
        all_bucket_rows = {"17:00": _memos(10), "09:00": _memos(10)}
        assert find_anomaly_bucket(all_bucket_rows, peak_max_count=10) is None

    def test_off_peak_exceeding_peak_returns_bucket_key(self):
        all_bucket_rows = {"17:00": _memos(10), "09:00": _memos(50)}
        assert find_anomaly_bucket(all_bucket_rows, peak_max_count=10) == "09:00"

    def test_picks_largest_off_peak_bucket(self):
        all_bucket_rows = {
            "17:00": _memos(10),
            "09:00": _memos(20),
            "14:30": _memos(79),
            "02:00": _memos(30),
        }
        assert find_anomaly_bucket(all_bucket_rows, peak_max_count=10) == "14:30"

    def test_zero_peak_count_still_requires_exceeding(self):
        # 피크타임 데이터 자체가 없는 날(peak_max_count=0)이면 오프피크에 1건만 있어도 초과
        all_bucket_rows = {"09:00": _memos(1)}
        assert find_anomaly_bucket(all_bucket_rows, peak_max_count=0) == "09:00"

    def test_empty_all_bucket_rows_returns_none(self):
        assert find_anomaly_bucket({}, peak_max_count=0) is None


class TestHasGemmaFailures:
    def test_no_failures(self):
        content = {
            "risk_rows": [{"main": "네트워크·앱 오류", "gemma_error": None}],
            "peak_bucket": {"gemma_error": None},
            "anomaly_bucket": None,
        }
        assert has_gemma_failures(content) is False

    def test_category_failure(self):
        content = {"risk_rows": [{"main": "네트워크·앱 오류", "gemma_error": "타임아웃"}]}
        assert has_gemma_failures(content) is True

    def test_peak_bucket_failure(self):
        content = {"risk_rows": [], "peak_bucket": {"gemma_error": "타임아웃"}}
        assert has_gemma_failures(content) is True

    def test_anomaly_bucket_failure(self):
        content = {"risk_rows": [], "anomaly_bucket": {"gemma_error": "타임아웃"}}
        assert has_gemma_failures(content) is True

    def test_missing_keys_treated_as_no_failure(self):
        assert has_gemma_failures({}) is False
