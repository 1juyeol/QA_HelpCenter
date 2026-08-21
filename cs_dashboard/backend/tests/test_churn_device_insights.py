# features/issues/churn_device_insights.py의 순수 함수(추출·분류 로직) 유닛 테스트.
# 실제 DB 집계 함수(get_churn_reason_stats 등)는 DB 의존이라 여기서는 제외하고,
# 텍스트 → 값 추출/분류만 결정론적으로 검증한다.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from features.issues.churn_device_insights import (
    extract_churn_reason,
    classify_churn_reason,
    extract_device_model,
    CHURN_REASON_FALLBACK,
)


class TestExtractChurnReason:
    def test_extracts_single_line_value(self):
        memo = "*해지요청 사유 : 해지 문의  / *특이사항 : \n담당선생님 전달"
        assert extract_churn_reason(memo) == "해지 문의"

    def test_extracts_multiline_value_until_next_field(self):
        memo = (
            "*해지요청 사유 : \n"
            "안녕하세요!\n"
            "해지 위약금 문의 주셨습니다. 확인 후 상담 바랍니다.\n"
            "\n"
            "*특이사항 : \n"
            "담당선생님 전달하여 상담 받아보실 수 있도록 하겠다 안내"
        )
        reason = extract_churn_reason(memo)
        assert "위약금 문의" in reason
        assert "특이사항" not in reason

    def test_no_field_returns_none(self):
        assert extract_churn_reason("해지 요청 주심. 위약금 문의.") is None


class TestClassifyChurnReason:
    def test_penalty_bucket(self):
        assert classify_churn_reason("해지시 위약금 문의") == "위약금·비용 부담"

    def test_competitor_bucket(self):
        assert classify_churn_reason("이미 학원에 등록하여 윙크 해지 원한다") == "타 서비스 이동"

    def test_refund_bucket(self):
        assert classify_churn_reason("학습비 청약철회 결제 취소 문의") == "환불·청약철회"

    def test_no_keyword_falls_back(self):
        assert classify_churn_reason("해지 문의 주셔서 전달 드립니다.") == CHURN_REASON_FALLBACK


class TestExtractDeviceModel:
    def test_extracts_model_name(self):
        memo = "*교체 학습기 : 윙크 스쿨 단말기\n*확인사항 : 키보드 숫자 1일 눌러지지 않음 /\n"
        assert extract_device_model(memo) == "윙크 스쿨 단말기"

    def test_no_field_returns_none(self):
        assert extract_device_model("학습기 교체 요청 주심") is None
