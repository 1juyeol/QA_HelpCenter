# -*- coding: utf-8 -*-
# features/issues/classifier.py의 classify() 유닛 테스트.
# 2026-06 기타 흡수용 키워드 보강(기기 교체 요청·누락·오배송)이 의도대로 분류되는지,
# 기존 우선순위(해지 > 기기) 규칙이 보강 후에도 깨지지 않는지(회귀 방지) 검증한다.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from features.issues.classifier import classify, extract_symptom_fields, find_matched_keyword, apply_disabled_keywords
import features.issues.classifier as classifier_module


class TestExtractSymptomFields:
    def test_extracts_three_fields(self):
        memo = (
            "[1차] *확인사항 :\n"
            "- 상세증상 : 코칭 중 소리가 안 들림\n"
            "- 해당증상 발생 시 단말기, 공유기 재부팅 여부 :\n"
            "점검 요청 내용 : 소리불량 (코칭때 목소리가 작게 들린다)\n"
            "*후속관리 : 미진행"
        )
        result = extract_symptom_fields(memo)
        assert "소리" in result
        assert "공유기 재부팅" not in result
        assert "후속관리" not in result

    def test_extracts_hwak_insahan_same_line(self):
        # *확인사항 : 에 값이 바로 있는 경우
        memo = (
            "*교체 학습기 : 윙크 스쿨 단말기\n"
            "*확인사항 : 키보드 숫자 1일 눌러지지 않음 /\n"
            "- 상세증상 :\n"
            "*안내사항 : 기기 검수후 배송\n"
            "- 선출고 후회수 안내\n"
            "*후속관리 : 미진행"
        )
        result = extract_symptom_fields(memo)
        assert "키보드" in result
        assert "선출고" not in result
        assert "안내사항" not in result

    def test_non_template_returns_original(self):
        memo = "해지 요청 주심. 위약금 문의."
        assert extract_symptom_fields(memo) == memo

    def test_template_with_blank_fields_returns_empty_not_original(self):
        # 확인사항이 비어있으면 원문(교체 물류용 행정 필드 포함) 대신 빈 문자열을 반환해야
        # 한다 — 안 그러면 "동글 연결 불가능" 같은 문구가 증상인 것처럼 AI 분석에 섞여 들어간다.
        memo = (
            "*교체 학습기 : 윙크 스쿨 단말기 / 기본형 / 동글 연결 불가능\n\n"
            "*확인사항 : \n*안내사항 : \n– 선출고 후회수 안내\n*후속관리 : 미진행"
        )
        assert extract_symptom_fields(memo) == ""

    def test_template_classify_not_wifi(self):
        # 공유기 재부팅이 체크리스트에만 있고 실제 증상은 소리 문제인 메모
        memo = (
            "[1차] *확인사항 :\n"
            "- 상세증상 : 코칭 중 목소리 작게 들림\n"
            "- 해당증상 발생 시 단말기, 공유기 재부팅 여부 :\n"
            "점검 요청 내용 : 소리불량\n"
            "*후속관리 : 미진행"
        )
        main, _ = classify(memo)
        assert main != "네트워크·앱 오류"

    def test_keyboard_memo_not_배송(self):
        # 선출고 후회수 안내가 있어도 배송으로 잘못 분류되면 안 됨
        memo = (
            "*교체 학습기 : 윙크 스쿨 단말기\n"
            "*확인사항 : 키보드 숫자 1일 눌러지지 않음 /\n"
            "- 상세증상 :\n"
            "*안내사항 : 기기 검수후 배송\n"
            "- 선출고 후회수 안내\n"
            "*후속관리 : 미진행"
        )
        main, _ = classify(memo)
        assert main != "교재·물류·배송"


class TestNewKeywords:
    # 보강된 기기 교체 요청 키워드 → 기기·하드웨어 오류로 분류되어야 함
    def test_device_swap_keywords(self):
        for memo in [
            "학습기 교체 요청 주심",
            "재교체 진행하기로 함",
            "정상적으로 교체 접수되었음",
            "교체 받은 학습기 인증화면으로 안 넘어감",
            "터치펜 교체 후 회수 안내",
            "원격 점검 도와드림",
            "점검 부재 / 문자발송",
            "점검 요청 주심",
        ]:
            main, sub = classify(memo)
            assert (main, sub) == ("교재·물류·배송", "기기 교체 요청"), memo

    # 보강된 누락·오배송 키워드
    def test_missing_delivery_keyword(self):
        main, sub = classify("영상 누락되어 재발송 안내")
        assert (main, sub) == ("교재·물류·배송", "누락·오배송")


class TestTemplateKeywords:
    # 템플릿 추출 후 새 키워드 매칭 검증
    def test_safe_mode_is_charging_power_defect(self):
        memo = (
            "*확인사항 : 안전모드로 나온다는 문의\n"
            "- 상세증상 : 안전모드로 확인\n"
            "*안내 내용 : 강제재부팅 안내\n"
            "*후속관리 : 미진행"
        )
        main, sub = classify(memo)
        assert (main, sub) == ("기기·하드웨어 오류", "충전·전원 불량")

    def test_learning_interrupted_is_freezing(self):
        memo = (
            "*확인사항 : 학습중 끊기거나 다음화면으로 넘어가지 않음\n"
            "- 상세증상 :\n"
            "*후속관리 : 미진행"
        )
        main, sub = classify(memo)
        assert main == "네트워크·앱 오류"

    def test_slow_response_is_freezing(self):
        memo = (
            "*확인사항 : 학습기 느리게 반응함\n"
            "- 상세증상 :\n"
            "*후속관리 : 미진행"
        )
        main, sub = classify(memo)
        assert (main, sub) == ("네트워크·앱 오류", "학습 끊김·멈춤")

    def test_freeze_symptom_is_freezing(self):
        memo = (
            "*확인사항 : 멈춤 증상이 있었음 / 학습 후 완료가 되지 않고 영상이 처음부터 나옴\n"
            "- 상세증상 :\n"
            "*후속관리 : 미진행"
        )
        main, sub = classify(memo)
        assert main == "네트워크·앱 오류"

    def test_beobuk_is_freezing(self):
        # 버벅거림 변형 — 버벅대는
        memo = (
            "*확인사항 : 학습이 중 끊기고 버벅대는 증상이 있음\n"
            "- 상세증상 :\n"
            "*후속관리 : 미진행"
        )
        main, sub = classify(memo)
        assert (main, sub) == ("네트워크·앱 오류", "학습 끊김·멈춤")

    def test_slow_symptom_is_freezing(self):
        # 느림 증상 / 학습시 느림 / 너무 느려서
        for memo_text in [
            "*확인사항 : 학습시 느림 증상\n- 상세증상 : 학습시 느림 증상\n*후속관리 : 미진행",
            "*확인사항 : 학습시 느림 및 끊김\n- 상세증상 : 느림 및 끊김\n*후속관리 : 미진행",
            "점검 요청 내용 : 기타 (기기가 너무 느려서 사용하다가 안함)\n*후속관리 : 미진행",
        ]:
            main, sub = classify(memo_text)
            assert (main, sub) == ("네트워크·앱 오류", "학습 끊김·멈춤"), memo_text

    def test_frequent_error_in_jeongeom_is_app_error(self):
        # 점검 요청 내용에 "오류가 자주 발생" 패턴
        memo = (
            "[1차] *확인사항 :\n"
            "- 상세증상 :\n"
            "점검 요청 내용 : 기타 (캐츠홈 윙크 학습중 문제풀이때 오류가 자주 발생해서 점검 원하십니다.)\n"
            "*후속관리 : 미진행"
        )
        main, sub = classify(memo)
        assert (main, sub) == ("네트워크·앱 오류", "앱 오류")


class TestPriorityRegression:
    # 해지는 기기보다 우선순위가 높다 — 둘 다 매칭돼도 해지로 가야 함
    def test_churn_beats_device(self):
        main, sub = classify("학습기 교체 안내했으나 해지요청 하심")
        assert main == "해지·유지 상담"

    # 같은 기기 대분류 안에서는 구체적 결함 사유(충전·터치·부팅·파손)가 기기 교체 요청보다
    # 먼저 걸린다 — "학습기 교체" 같은 처리 템플릿 문구가 같이 있어도, 확인사항에 실제 증상이
    # 있으면 그 증상으로 분류해야 결함 원인 집계(주간·일별 리포트)에서 사라지지 않는다.
    # 순수 "기기 교체 요청"은 구체적 증상 키워드가 하나도 안 걸리는 경우에만 확정된다.
    def test_charging_beats_swap_same_main(self):
        main, sub = classify("충전이 안되어 학습기 교체 문의")
        assert (main, sub) == ("기기·하드웨어 오류", "충전·전원 불량")

    def test_swap_still_wins_when_no_specific_reason(self):
        main, sub = classify("*교체 학습기 : 윙크 학습 단말기 / 기본형 / 동글 연결 불가능")
        assert (main, sub) == ("교재·물류·배송", "기기 교체 요청")

    # 보강과 무관한 기존 분류는 그대로
    def test_existing_unchanged(self):
        assert classify("와이파이 연결이 안됨")[0] == "네트워크·앱 오류"
        assert classify("위약금 문의 주심")[1] == "해지금·위약금 문의"
        assert classify("") == (None, None)


class TestDeviceSwapReasonOverride:
    # classify()가 "기기 교체 요청"으로 확정하기 직전, classify_device_swap_reason()으로
    # 한 번 더 판단해서 결함 사유가 명확하면 그 실제 카테고리로 대신 확정하는지 검증한다.

    def test_charging_defect_overrides_to_real_category(self):
        memo = "*교체 학습기 : 윙크 스쿨 단말기 / 기본형 / 동글 연결 불가능\n*확인사항 : 완충해도 방전이 급격하게 됨"
        assert classify(memo) == ("기기·하드웨어 오류", "충전·전원 불량")

    def test_morpheme_only_defect_still_overrides(self):
        # 문자열 키워드엔 없고 형태소(어간) 매칭으로만 잡히는 활용형("벌어지고 있음")도
        # classify() 최종 결과에 반영되어야 한다.
        memo = "*교체 학습기 : 윙크 스쿨 단말기 / 기본형 / 동글 연결 불가능\n*확인사항 : 케이스가 벌어지고 있어요"
        assert classify(memo) == ("기기·하드웨어 오류", "분실, 파손")

    def test_no_reason_falls_back_to_device_swap_request(self):
        memo = "*교체 학습기 : 윙크 스쿨 단말기 / 기본형 / 동글 연결 불가능\n*확인사항 : "
        assert classify(memo) == ("교재·물류·배송", "기기 교체 요청")

    def test_non_defect_reason_falls_back_to_device_swap_request(self):
        # "고객 요청형(비고장)"처럼 REASON_TO_CATEGORY에 없는 사유는 override하지 않는다.
        memo = "*교체 학습기 : 윙크 스쿨 단말기 / 기본형 / 동글 연결 불가능\n*확인사항 : 최신기종으로 교체 해달라고 하심"
        assert classify(memo) == ("교재·물류·배송", "기기 교체 요청")


class TestOverbroadKeywordFix:
    # 2026-08-20 오분류 신고 회귀 테스트 — "인증번호"/"캐시삭제"/"재회수" 키워드가
    # 너무 일반적이어서 무관한 상담이 앱 오류·기기 장기미회수로 잘못 분류되던 문제 수정.

    def test_card_change_auth_code_not_app_error(self):
        # 결제카드 변경 중 휴대폰 인증번호 오류 — "인증번호" 키워드로 앱 오류가 잘못 매칭되던 케이스
        memo = (
            "결제카드 변경시 휴대폰 인증번호 오류로 변경이 되지 않는다며 직접 변경요청. "
            "개인정보보로로 카드번호 받을수 없음 안내 ARS 문자발송 *후속관리 : 미진행"
        )
        main, sub = classify(memo)
        assert main == "미납·결제"
        assert sub == "결제·환불 처리"

    def test_internet_speed_test_device_swap_not_app_error(self):
        # 인터넷 속도측정 후 캐시삭제 언급 — "캐시삭제" 키워드로 앱 오류가 잘못 매칭되던 케이스
        # 실제로는 기기교체요청 건이므로 기기·하드웨어 오류로 분류되어야 함
        memo = (
            "*인터넷 속도측정 - 다운로드 : 19.45 /16.80 - 업로드 : /31.45 /47.17 "
            "- 지연시간 : 0 /O - 손실률 : 100 - 속도 측정후 캐시삭제 "
            "- 통신사 회신점검 안내드리니 공유기도 재 설치했다고 함 - 기기교체요청 - *후속관리 : 미진행"
        )
        main, sub = classify(memo)
        assert (main, sub) == ("교재·물류·배송", "기기 교체 요청")

    def test_book_recollection_not_device_long_uncollected(self):
        # 도서 재회수 요청 — "재회수" 키워드로 기기 장기미회수가 잘못 매칭되던 케이스
        # 회수 요청 자체는 배송·회수 처리로 분류되어야 함 (대분류는 교재·물류·배송으로 동일)
        memo = "5개월 차 도서 재회수 요청 *후속관리 : 미진행"
        main, sub = classify(memo)
        assert main == "교재·물류·배송"
        assert sub != "기기 장기미회수"

    def test_device_recollection_still_long_uncollected(self):
        # "재회수"를 통째로 지우면 진짜 학습기 재회수 건까지 기타로 떨어지는 회귀가 있었음.
        # "학습기 재회수"/"기기 재회수"처럼 기기 단어가 붙은 구문은 계속 기기 장기미회수로 잡혀야 함
        memo = "종료 회원 학습기 재회수 접수 요청 / 자마드 전달 / *후속관리 : 미진행"
        main, sub = classify(memo)
        assert (main, sub) == ("교재·물류·배송", "기기 장기미회수")

    def test_haeji_yocheong_sayu_field_not_stripped(self):
        # *해지요청 사유 : <내용> 필드가 _META_FIELD 정규식에 걸려 라벨·내용이 통째로
        # 삭제되면서 기타로 떨어지던 문제. "해지요청" 키워드는 보존되어 해지 상담으로 잡혀야 함
        memo = (
            "*해지요청 사유 : 해지 문의  / *특이사항 : 해지 상담 부탁드립니다.  / "
            "담당선생님 전달하여 상담 받아보실 수 있도록 하겠다 안내 / *후속관리 : 미진행"
        )
        main, sub = classify(memo)
        assert (main, sub) == ("해지·유지 상담", "해지 상담")


class TestReplacementTemplateRootCause:
    # *교체학습기 템플릿 헤더는 확인사항/상세증상에 구체적 결함 사유가 없을 때만 기기 교체
    # 요청으로 확정한다. 사유가 적혀 있으면 그 사유가 우선이어야 한다 — 예전엔 헤더만 보고
    # 무조건 기기 교체 요청으로 확정해서, 확인사항에 적힌 충전 불량·기기 파손 등 실제 원인이
    # 리스크 카테고리 분석에서 통째로 사라지는 문제가 있었다.
    def test_charging_reason_in_confirmation_field_wins_over_template(self):
        memo = (
            "*교체 학습기 : 윙크 스쿨 단말기 / 기본형 / 동글 연결 불가능\n\n"
            "*확인사항 : 학습기 충전이 되지 않음. 충전선을 빼면 학습기가 꺼지는 현상 발생. "
            "기기교체 진행\n- 상세증상 : 충전불량\n*안내사항 : 기기교체 안내. 주소확인\n"
            "- 선출고 후회수 안내\n*후속관리 : 미진행"
        )
        main, sub = classify(memo)
        assert (main, sub) == ("기기·하드웨어 오류", "충전·전원 불량")

    def test_physical_damage_reason_in_confirmation_field_wins_over_template(self):
        memo = (
            "*교체 학습기 : 윙크 학습 단말기 / 기본형 / 동글 연결 불가능\n\n"
            "*확인사항 : 아이가 학습기를 낙하 파손시켰다고 합니다.\n"
            "*안내사항 : \n- 고객과실로 판단될 시 비용발생됨 안내 \n- 선출고 후회수 안내\n"
            "*후속관리 : 미진행"
        )
        main, sub = classify(memo)
        assert (main, sub) == ("기기·하드웨어 오류", "분실, 파손")

    def test_no_stated_reason_still_falls_back_to_replacement_request(self):
        # 확인사항이 비어있는 순수 교체 요청은 여전히 기기 교체 요청으로 잡혀야 한다
        memo = (
            "*교체 학습기 : 윙크 스쿨 단말기 / 기본형(2.0) / 동글 연결 불가능\n\n"
            "*확인사항 : \n*안내사항 : \n– 선출고 후회수 안내\n*후속관리 : 미진행"
        )
        main, sub = classify(memo)
        assert (main, sub) == ("교재·물류·배송", "기기 교체 요청")


class TestFindMatchedKeyword:
    def test_returns_matched_keyword(self):
        assert find_matched_keyword("와이파이 연결이 안됨", "와이파이 오류") == "와이파이 연결"

    def test_returns_none_when_no_keyword_present(self):
        assert find_matched_keyword("해지 문의드립니다", "와이파이 오류") is None

    def test_returns_none_for_unknown_sub(self):
        assert find_matched_keyword("아무 내용", "존재하지 않는 소분류") is None


class TestApplyDisabledKeywords:
    def setup_method(self):
        self._rules_snapshot = [(sub, list(kws)) for sub, kws in classifier_module.RULES]

    def teardown_method(self):
        classifier_module.RULES[:] = self._rules_snapshot

    def test_disabled_keyword_removed_from_rules(self, monkeypatch):
        monkeypatch.setattr(
            "core.classifier_keyword_settings.get_disabled_keywords",
            lambda: {("와이파이 오류", "핫스팟")},
        )
        apply_disabled_keywords()
        kws = dict(classifier_module.RULES)["와이파이 오류"]
        assert "핫스팟" not in kws
        assert "와이파이 연결" in kws  # 다른 키워드는 그대로 남아있어야 한다

    def test_no_disabled_keywords_leaves_rules_unchanged(self, monkeypatch):
        monkeypatch.setattr("core.classifier_keyword_settings.get_disabled_keywords", lambda: set())
        before = [(sub, list(kws)) for sub, kws in classifier_module.RULES]
        apply_disabled_keywords()
        assert classifier_module.RULES == before


class TestFindMatchedKeywordDeviceSwapFallback:
    # 일반 RULES에 안 걸려도, "기기 교체 요청" 사유 분석 이중로직으로 이 소분류에 온 건이면
    # 그 근거(키워드 또는 형태소)를 보여줘야 한다.
    def test_falls_back_to_defect_keyword_when_no_direct_rule_match(self):
        # "밧데리가"는 classifier.py의 일반 RULES엔 없고 churn_device_insights.py의 사유
        # 분석 키워드 목록에만 있다(검증됨) — 일반 매칭이 실패해야 이 폴백이 실제로 실행된다.
        memo = "*교체 학습기 : 윙크 스쿨 단말기 / 기본형 / 동글 연결 불가능\n*확인사항 : 밧데리가 금방 없어짐"
        assert find_matched_keyword(memo, "충전·전원 불량") == "밧데리가"

    def test_falls_back_to_morpheme_stem_when_only_morpheme_matches(self):
        # "닳"은 문자열 키워드 목록엔 없고 형태소 매칭으로만 잡힌다(검증됨).
        memo = "*교체 학습기 : 윙크 스쿨 단말기 / 기본형 / 동글 연결 불가능\n*확인사항 : 충전 케이블 피복이 다 닳아버렸어요"
        assert find_matched_keyword(memo, "충전·전원 불량") == "닳(형태소)"

    def test_returns_none_when_reason_maps_to_different_sub(self):
        # 충전 결함으로 판정되는 메모를 엉뚱한 소분류로 조회하면 None
        memo = "*교체 학습기 : 윙크 스쿨 단말기 / 기본형 / 동글 연결 불가능\n*확인사항 : 완충해도 방전이 급격하게 됨"
        assert find_matched_keyword(memo, "터치·입력 불량") is None
