# -*- coding: utf-8 -*-
# features/report/report_utils.py의 describe_gemma_failure() 유닛 테스트.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from features.report.report_utils import describe_gemma_failure


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
