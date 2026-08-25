# -*- coding: utf-8 -*-
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
    normalize_device_model,
    classify_device_swap_reason,
    device_swap_reason_tier,
    CHURN_REASON_FALLBACK,
    DEVICE_SWAP_REASON_NO_HISTORY,
    DEVICE_SWAP_REASON_UNCLEAR,
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


class TestNormalizeDeviceModel:
    def test_merges_alias_into_canonical_name(self):
        assert normalize_device_model("윙크 캐릭터 단말기") == "윙크 학습 단말기"

    def test_unaliased_name_unchanged(self):
        assert normalize_device_model("윙크 스쿨 단말기") == "윙크 스쿨 단말기"


class TestClassifyDeviceSwapReason:
    def test_defect_keyword_match(self):
        memo = "*교체 학습기 : 윙크 스쿨 단말기\n*확인사항 : 충전이 안됨"
        assert classify_device_swap_reason(memo) == "충전·전원 불량"

    def test_spacing_variant_matches_via_normalization(self):
        # "전원버튼"은 붙여쓰기 키워드지만 실제 메모는 띄어써서 온다 — 정규화로 잡혀야 한다.
        memo = "*교체 학습기 : 윙크 스쿨 단말기\n*확인사항 : 전원 버튼 잘 안눌러짐"
        assert classify_device_swap_reason(memo) == "충전·전원 불량"

    def test_customer_request_keyword_match(self):
        memo = "*교체 학습기 : 윙크 스쿨 단말기\n*확인사항 : 최신기종으로 교체 해달라고 하심"
        assert classify_device_swap_reason(memo) == "고객 요청형(비고장)"

    def test_checklist_question_alone_does_not_false_positive(self):
        # 답변이 비어있는 점검 체크리스트 질문 문구("전원버튼" 포함)만 있으면 매칭되면 안 된다.
        memo = (
            "*교체 학습기 : 윙크 스쿨 단말기\n"
            "*확인사항 : \n"
            "- 충전기 연결상태에서 전원버튼 딸깍 눌렀을 때 배터리 잔량표시 노출여부 : \n"
            "*안내사항 : \n- 선출고 후회수 안내\n*후속관리 : 미진행"
        )
        assert classify_device_swap_reason(memo) == DEVICE_SWAP_REASON_NO_HISTORY

    def test_unmatched_with_real_text_is_unclear(self):
        memo = "*교체 학습기 : 윙크 스쿨 단말기\n*확인사항 : 이유는 딱히 없는데 그냥 바꿔달라고 하심"
        assert classify_device_swap_reason(memo) == DEVICE_SWAP_REASON_UNCLEAR

    def test_no_content_at_all_is_no_history(self):
        memo = "*교체 학습기 : 윙크 스쿨 단말기\n*확인사항 : \n*안내사항 : \n- 선출고 후회수 안내\n*후속관리 : 미진행"
        assert classify_device_swap_reason(memo) == DEVICE_SWAP_REASON_NO_HISTORY


class TestDeviceSwapReasonTier:
    def test_defect_is_clear(self):
        assert device_swap_reason_tier("충전·전원 불량") == "clear"

    def test_product_tier_change_is_clear(self):
        assert device_swap_reason_tier("상품·등급 전환") == "clear"

    def test_no_history_needs_review(self):
        assert device_swap_reason_tier(DEVICE_SWAP_REASON_NO_HISTORY) == "needs_review"

    def test_unclear_needs_review(self):
        assert device_swap_reason_tier(DEVICE_SWAP_REASON_UNCLEAR) == "needs_review"

    def test_customer_request_needs_review(self):
        assert device_swap_reason_tier("고객 요청형(비고장)") == "needs_review"
