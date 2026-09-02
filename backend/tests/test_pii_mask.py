# -*- coding: utf-8 -*-
# core/pii_mask.py의 mask_phone_numbers() 유닛 테스트.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.pii_mask import mask_phone_numbers


class TestMaskPhoneNumbers:
    def test_masks_hyphenated_number(self):
        assert mask_phone_numbers("010-1234-5678 부인입") == "010-xxxx-5678 부인입"

    def test_masks_number_without_hyphens(self):
        assert mask_phone_numbers("01012345678 부인입") == "010xxxx5678 부인입"

    def test_masks_multiple_numbers(self):
        text = "모 010-1111-2222, 부 010-3333-4444"
        assert mask_phone_numbers(text) == "모 010-xxxx-2222, 부 010-xxxx-4444"

    def test_does_not_mask_serial_number(self):
        # 시리얼 번호처럼 앞뒤에 다른 문자가 붙어있으면 마스킹하지 않는다 (회귀 테스트)
        text = "S/N : WD10191100323"
        assert mask_phone_numbers(text) == text

    def test_handles_none_and_empty(self):
        assert mask_phone_numbers(None) is None
        assert mask_phone_numbers("") == ""

    def test_leaves_text_without_phone_unchanged(self):
        text = "충전이 안 되어 교체 요청 주심"
        assert mask_phone_numbers(text) == text
