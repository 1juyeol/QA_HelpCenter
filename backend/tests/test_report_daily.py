# features/report/report_daily.py의 find_anomaly_bucket() 유닛 테스트.
# 피크타임(17~20시) 밖인데 그날 피크타임 최다 버킷보다 인입이 많은 버킷을 찾는 순수 함수.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from features.report.report_daily import (
    find_anomaly_bucket, has_gemma_failures, collect_gemma_failures, collect_gemma_failure_reasons,
    _clean_memo_line, _build_memo_brief,
    _build_bucket_brief, _BUCKET_EXAMPLES_PER_CATEGORY, _format_category_listing,
    _validate_cited_counts, _build_fallback_summary,
)


def _memos(n):
    return [{"id": i, "text": f"메모{i}"} for i in range(n)]


def _memo_at_hour(i, hour, long=True):
    text = f"학습기 관련 증상이 반복적으로 접수된 상담 메모 번호 {i}" if long else "짧음"
    return {"id": i, "text": text, "hour": hour}


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


class TestCollectGemmaFailures:
    def test_no_failures_returns_empty_list(self):
        content = {
            "risk_rows": [{"main": "네트워크·앱 오류", "gemma_error": None}],
            "peak_bucket": {"gemma_error": None},
            "anomaly_bucket": None,
        }
        assert collect_gemma_failures(content) == []

    def test_collects_category_peak_anomaly_names(self):
        content = {
            "risk_rows": [
                {"main": "네트워크·앱 오류", "gemma_error": None},
                {"main": "기기·하드웨어 오류", "gemma_error": "타임아웃"},
            ],
            "peak_bucket": {"gemma_error": "파싱 실패"},
            "anomaly_bucket": {"gemma_error": "빈 응답"},
        }
        assert collect_gemma_failures(content) == ["기기·하드웨어 오류", "피크타임", "이상시간대"]

    def test_missing_keys_treated_as_no_failure(self):
        assert collect_gemma_failures({}) == []


class TestCollectGemmaFailureReasons:
    def test_no_failures_returns_empty_list(self):
        content = {"risk_rows": [{"main": "네트워크·앱 오류", "gemma_error": None}]}
        assert collect_gemma_failure_reasons(content) == []

    def test_collects_name_and_reason(self):
        content = {
            "risk_rows": [
                {"main": "네트워크·앱 오류", "gemma_error": None},
                {"main": "기기·하드웨어 오류", "gemma_error": "타임아웃"},
            ],
            "peak_bucket": {"gemma_error": "파싱 실패"},
            "anomaly_bucket": {"gemma_error": "빈 응답"},
        }
        assert collect_gemma_failure_reasons(content) == [
            "기기·하드웨어 오류: 타임아웃",
            "피크타임: 파싱 실패",
            "이상시간대: 빈 응답",
        ]

    def test_missing_keys_treated_as_no_failure(self):
        assert collect_gemma_failure_reasons({}) == []


class TestCleanMemoLine:
    def test_long_enough_text_passes_through(self):
        memo = {"text": "학습기 관련 증상이 반복적으로 접수된 상담 메모입니다", "hour": 10}
        assert _clean_memo_line(memo) == "학습기 관련 증상이 반복적으로 접수된 상담 메모입니다"

    def test_short_text_excluded(self):
        assert _clean_memo_line({"text": "짧음", "hour": 10}) is None

    def test_truncated_to_150_chars(self):
        memo = {"text": "가" * 200, "hour": 10}
        assert len(_clean_memo_line(memo)) == 150

    def test_collapses_whitespace(self):
        memo = {"text": "학습기가    자꾸\n\n꺼진다고    하심 불편함 호소", "hour": 10}
        assert "  " not in _clean_memo_line(memo)


class TestBuildMemoBrief:
    def test_empty_memos_returns_empty(self):
        assert _build_memo_brief([], "기기 교체 요청") == {"prompt_text": "", "groups": []}

    def test_all_too_short_returns_empty(self):
        memos = [_memo_at_hour(i, 10, long=False) for i in range(5)]
        assert _build_memo_brief(memos, "기기 교체 요청") == {"prompt_text": "", "groups": []}

    def test_at_or_under_100_uses_all_without_bucketing(self):
        memos = [_memo_at_hour(i, 10) for i in range(80)]
        result = _build_memo_brief(memos, "기기 교체 요청")
        assert result["groups"] == [{"sub": "기기 교체 요청", "count": 80, "memos": []}]
        lines = result["prompt_text"].split("\n")
        assert lines[0] == "# 기기 교체 요청 (80건)"
        assert len(lines) == 81  # 헤더 1줄 + 메모 80줄
        assert lines[1].startswith("[1] ")
        assert lines[80].startswith("[80] ")

    def test_over_100_buckets_by_time_of_day(self):
        # 아침(09~12) 10건, 오후(13~17) 200건, 저녁(18~23) 200건 — 총 410건, 필터링 없이 전부 통과
        memos = (
            [_memo_at_hour(i, 10) for i in range(10)]
            + [_memo_at_hour(i, 14) for i in range(200)]
            + [_memo_at_hour(i, 19) for i in range(200)]
        )
        result = _build_memo_brief(memos, "기기 교체 요청")
        # 아침은 30건 상한보다 적은 10건 그대로, 오후는 30건, 저녁은 40건으로 캡 → 총 80건
        assert result["groups"][0]["count"] == 80

    def test_hours_outside_all_buckets_excluded_when_bucketing(self):
        # 101건 이상이라 버킷팅이 걸리는데, 새벽 3시는 아침/오후/저녁 어디에도 안 속해서 제외된다.
        memos = [_memo_at_hour(i, 3) for i in range(101)]
        result = _build_memo_brief(memos, "기기 교체 요청")
        assert result == {"prompt_text": "", "groups": []}

    def test_bucket_with_fewer_than_cap_uses_all_available(self):
        # 아침 5건뿐이면(30건 상한보다 적음) 5건 그대로, 오후 200건은 30건으로 캡
        memos = (
            [_memo_at_hour(i, 10) for i in range(5)]
            + [_memo_at_hour(i, 14) for i in range(200)]
        )
        result = _build_memo_brief(memos, "기기 교체 요청")
        assert result["groups"][0]["count"] == 35


class TestBuildMemoBriefDedupSuffix:
    def test_identical_texts_get_count_suffix(self):
        memos = (
            [{"id": i, "text": "학습기 화면이 계속 멈추는 증상 발생", "hour": 10} for i in range(2)]
            + [{"id": 99, "text": "터치가 전혀 반응하지 않는 문제 발생", "hour": 11}]
        )
        result = _build_memo_brief(memos, "학습 끊김·멈춤")
        lines = result["prompt_text"].split("\n")[1:]
        assert lines[0].endswith("(2건)")
        assert not lines[1].endswith("건)")  # 1건뿐인 줄엔 접미사가 안 붙는다


class TestValidateCitedCounts:
    def test_summary_using_only_provided_counts_passes(self):
        prompt_section = "[1] 충전이 안됨 (18건)\n[2] 터치가 안됨 (9건)"
        summary = "충전 불량이 18건, 터치 불량이 9건 확인됩니다."
        assert _validate_cited_counts(summary, prompt_section) is None

    def test_summary_inventing_a_count_fails(self):
        prompt_section = "[1] 오배송 건\n[2] 도서 누락 건"
        summary = "오배송이 3건, 도서 누락이 2건 확인됩니다."
        reason = _validate_cited_counts(summary, prompt_section)
        assert reason is not None
        assert "3건" in reason and "2건" in reason

    def test_summary_with_no_count_mentions_passes(self):
        prompt_section = "[1] 오배송 건\n[2] 도서 누락 건"
        summary = "오배송과 도서 누락 사례가 다수 확인됩니다."
        assert _validate_cited_counts(summary, prompt_section) is None


class TestBuildFallbackSummary:
    def test_distribution_table_groups_are_listed_in_order(self):
        prompt_section = (
            "# 결함 사유 분포 (전체 194건 중 결함으로 분류된 건, 정확히 집계된 수치)\n"
            "충전·전원 불량: 22건 (11.3%)\n"
            "터치·입력 불량: 14건 (7.2%)"
        )
        summary = _build_fallback_summary(prompt_section)
        assert "충전·전원 불량 22건" in summary
        assert "터치·입력 불량 14건" in summary
        assert summary.index("22건") < summary.index("14건")

    def test_dedup_memo_groups_are_listed(self):
        prompt_section = "# 학습 끊김·멈춤 (10건)\n[1] 화면이 멈춤 (3건)\n[2] 다른 증상"
        summary = _build_fallback_summary(prompt_section)
        assert "화면이 멈춤 3건" in summary

    def test_no_groups_falls_back_to_total_only(self):
        prompt_section = "# 누락·오배송 (7건)\n[1] 텍스트1\n[2] 텍스트2"
        summary = _build_fallback_summary(prompt_section)
        assert "7건" in summary
        assert "달라" in summary  # 세부 내용이 서로 달라 집계 못함을 밝히는 문구

    def test_no_header_and_no_groups_returns_generic_fallback_text(self):
        assert _build_fallback_summary("") == "집계 가능한 데이터가 없어 요약을 생략합니다."


def _bucket_memo(i, main, long=True):
    text = f"학습기 관련 증상이 반복적으로 접수된 상담 메모 번호 {i}" if long else "짧음"
    return {"id": i, "text": text, "main": main, "sub": "소분류"}


class TestBuildBucketBrief:
    def test_distribution_covers_all_categories_with_exact_counts(self):
        memos = (
            [_bucket_memo(i, "네트워크·앱 오류") for i in range(12)]
            + [_bucket_memo(i, "기기·하드웨어 오류") for i in range(8)]
        )
        result = _build_bucket_brief(memos)["text"]
        assert "# 카테고리 분포 (전체 20건, 정확히 집계된 수치)" in result
        assert "네트워크·앱 오류: 12건 (60.0%)" in result
        assert "기기·하드웨어 오류: 8건 (40.0%)" in result

    def test_examples_labeled_with_category_and_capped_per_category(self):
        memos = [_bucket_memo(i, "네트워크·앱 오류") for i in range(10)]
        result = _build_bucket_brief(memos)["text"]
        assert result.count("(네트워크·앱 오류)") == _BUCKET_EXAMPLES_PER_CATEGORY

    def test_no_single_category_dominates_examples(self):
        # 한 카테고리가 압도적으로 많아도, 예시는 카테고리당 상한만큼만 뽑혀 다른 카테고리도
        # 예시에 등장할 여지가 남는다 (예전엔 앞에서부터 30건이라 이런 상황에서 한쪽만 보였다).
        memos = (
            [_bucket_memo(i, "네트워크·앱 오류") for i in range(50)]
            + [_bucket_memo(i, "기기·하드웨어 오류") for i in range(3)]
        )
        result = _build_bucket_brief(memos)["text"]
        assert "(기기·하드웨어 오류)" in result

    def test_short_memos_excluded_from_examples_but_counted_in_distribution(self):
        memos = [_bucket_memo(i, "네트워크·앱 오류", long=False) for i in range(5)]
        result = _build_bucket_brief(memos)["text"]
        assert "네트워크·앱 오류: 5건 (100.0%)" in result
        assert "# 대표 예시" not in result

    def test_dominant_category_at_or_above_40_percent_asks_for_specific_reason(self):
        memos = (
            [_bucket_memo(i, "네트워크·앱 오류") for i in range(8)]  # 40.0%
            + [_bucket_memo(i, "기기·하드웨어 오류") for i in range(12)]
        )
        result = _build_bucket_brief(memos)["text"]
        assert "1위 카테고리('기기·하드웨어 오류')가 전체의 60.0%로 뚜렷하게 많습니다" in result
        assert "구체적으로 언급하세요" in result

    def test_no_dominant_category_below_40_percent_forbids_invented_reason(self):
        memos = (
            [_bucket_memo(i, "네트워크·앱 오류") for i in range(3)]
            + [_bucket_memo(i, "기기·하드웨어 오류") for i in range(3)]
            + [_bucket_memo(i, "미납·결제") for i in range(3)]
        )
        result = _build_bucket_brief(memos)["text"]
        assert "특정 카테고리가 40% 이상을 차지하지 않았습니다" in result
        assert "없는 원인을 지어내지 말고" in result

    def test_top_category_field_matches_the_highest_ranked_category(self):
        memos = (
            [_bucket_memo(i, "네트워크·앱 오류") for i in range(8)]
            + [_bucket_memo(i, "기기·하드웨어 오류") for i in range(12)]
        )
        top = _build_bucket_brief(memos)["top_category"]
        assert top == {"name": "기기·하드웨어 오류", "count": 12, "pct": 60.0}

    def test_gita_never_picked_as_top_category_even_with_highest_count(self):
        # "기타"는 건수가 가장 많아도 실체가 없는 잔여 분류라 1위로 뽑히면 안 된다 — 실제로
        # 이렇게 뽑혀서 강조가 엉뚱한 곳에 걸렸던 사례가 있었다.
        memos = (
            [_bucket_memo(i, "기타") for i in range(21)]
            + [_bucket_memo(i, "기기·하드웨어 오류") for i in range(21)]
            + [_bucket_memo(i, "해지·유지 상담") for i in range(14)]
        )
        result = _build_bucket_brief(memos)
        assert result["top_category"]["name"] == "기기·하드웨어 오류"

    def test_gita_always_sorted_last_in_distribution_text(self):
        memos = (
            [_bucket_memo(i, "기타") for i in range(21)]
            + [_bucket_memo(i, "기기·하드웨어 오류") for i in range(21)]
            + [_bucket_memo(i, "해지·유지 상담") for i in range(14)]
        )
        text = _build_bucket_brief(memos)["text"]
        dist_block = text.split("\n\n")[0]
        lines = [line for line in dist_block.split("\n") if "건 (" in line]
        assert lines[-1].startswith("기타:")


class TestFormatCategoryListing:
    def test_formats_each_category_with_count_and_percent(self):
        sorted_mains = [("충전·전원 불량", 48), ("터치·입력 불량", 16)]
        result = _format_category_listing(sorted_mains, total=213)
        assert result == "충전·전원 불량 48건(22.5%), 터치·입력 불량 16건(7.5%) 순으로 접수되었습니다."

    def test_preserves_given_order_gita_included(self):
        # 정렬 자체는 호출부(_build_bucket_brief)의 책임이고, 이 함수는 받은 순서를 그대로
        # 문장으로 옮기기만 한다 — "기타 항상 마지막"을 이 함수가 아니라 정렬에서 보장한다.
        sorted_mains = [("기기·하드웨어 오류", 21), ("해지·유지 상담", 14), ("기타", 21)]
        result = _format_category_listing(sorted_mains, total=56)
        assert result.index("기기·하드웨어 오류") < result.index("해지·유지 상담") < result.index("기타")

    def test_single_category(self):
        result = _format_category_listing([("기타", 5)], total=5)
        assert result == "기타 5건(100.0%) 순으로 접수되었습니다."


class TestBuildBucketBriefListingField:
    def test_listing_matches_gita_last_sort_order(self):
        memos = (
            [_bucket_memo(i, "기타") for i in range(21)]
            + [_bucket_memo(i, "기기·하드웨어 오류") for i in range(21)]
            + [_bucket_memo(i, "해지·유지 상담") for i in range(14)]
        )
        listing = _build_bucket_brief(memos)["listing"]
        assert listing.endswith("기타 21건(37.5%) 순으로 접수되었습니다.")
        assert listing.index("기기·하드웨어 오류") < listing.index("기타")
