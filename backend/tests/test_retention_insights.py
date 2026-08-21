# features/issues/retention_insights.py의 extract_retention_offer() 유닛 테스트.
# get_retention_stats()는 DB 의존이라 제외하고, 텍스트 → 오퍼명 추출만 결정론적으로 검증한다.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from features.issues.retention_insights import extract_retention_offer


class TestExtractRetentionOffer:
    def test_extracts_offer_name(self):
        memo = "[3차 상담]\n-성공(수학단단과무교재)\n-결제일 27일 \n-유지부서 혜택으로..."
        assert extract_retention_offer(memo) == "수학단단과무교재"

    def test_normalizes_internal_whitespace(self):
        memo = "-성공(한글 단단과교재)\n-결제일 15일"
        assert extract_retention_offer(memo) == "한글단단과교재"

    def test_unclosed_paren_returns_none(self):
        # 닫는 괄호가 없어 뒤쪽 무관한 괄호까지 잘못 잡아먹는 데이터 오류 케이스 — 추출 안 함이 맞음
        memo = "-성공(아이시간없음\n-결제일 15일\n-영어는 다시 보기 가능. 한글 단단과무교재(40000원)5개월 유지"
        assert extract_retention_offer(memo) is None

    def test_no_field_returns_none(self):
        assert extract_retention_offer("해지 방어 상담일 : 26.05.15") is None
