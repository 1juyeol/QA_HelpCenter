# -*- coding: utf-8 -*-
# features/report/report_utils.py의 describe_gemma_failure()/gemma_detail() 유닛 테스트.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from features.report.report_utils import describe_gemma_failure, gemma_detail, INSUFFICIENT_SUMMARY, _MIN_ANALYSIS_MEMOS


class TestDescribeGemmaFailure:
    def test_empty_response(self):
        assert describe_gemma_failure("") == "Gemma 응답 없음 (빈 응답)"

    def test_short_garbage_response(self):
        result = describe_gemma_failure("```")
        assert "3자" in result
        assert "```" in result

    def test_includes_length_and_preview(self):
        raw = "이건 JSON이 아니라 그냥 설명입니다"
        result = describe_gemma_failure(raw)
        assert str(len(raw)) in result
        assert "이건 JSON이 아니라" in result

    def test_long_response_truncated_preview(self):
        raw = "가" * 200
        result = describe_gemma_failure(raw)
        assert "200자" in result
        assert len(result) < 200


class TestGemmaDetail:
    def test_no_data(self):
        assert gemma_detail("date=2026-08-19", {}) == "date=2026-08-19, status=no_data"

    def test_success_includes_elapsed(self):
        result = gemma_detail("date=2026-08-19", {"summary": "요약", "elapsed": 12.3})
        assert result == "date=2026-08-19, status=success, elapsed=12.3"

    def test_failed_includes_elapsed_and_error(self):
        result = gemma_detail("date=2026-08-19", {"gemma_error": "실패 사유", "elapsed": 133.0})
        assert result == "date=2026-08-19, status=failed, elapsed=133.0, error=실패 사유"

    def test_includes_prompt_at_end(self):
        result = gemma_detail("date=2026-08-19", {"gemma_error": "실패", "elapsed": 1.0, "gemma_prompt": "전문, 내용"})
        assert result == "date=2026-08-19, status=failed, elapsed=1.0, error=실패, prompt=전문, 내용"

    def test_no_elapsed_field_omitted(self):
        result = gemma_detail("date=2026-08-19", {"summary": "요약"})
        assert result == "date=2026-08-19, status=success"

    def test_insufficient_data_without_count_uses_generic_reason(self):
        result = gemma_detail("date=2026-08-19", {"insufficient_data": True, "elapsed": 0.5})
        assert result == f"date=2026-08-19, status=insufficient_data, reason={INSUFFICIENT_SUMMARY}, elapsed=0.5"

    def test_insufficient_data_with_count_includes_specific_reason(self):
        result = gemma_detail("date=2026-08-19", {"insufficient_data": True, "analysis_count": 2, "elapsed": 0.5})
        assert result == (
            f"date=2026-08-19, status=insufficient_data, "
            f"reason=구체적 증상 데이터가 2건으로 분석 최소 기준({_MIN_ANALYSIS_MEMOS}건)에 못 미쳐 제외되었습니다., elapsed=0.5"
        )
