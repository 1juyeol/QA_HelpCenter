# -*- coding: utf-8 -*-
# features/issues/classifier.py의 classify() 유닛 테스트.
# 2026-06 기타 흡수용 키워드 보강(기기 교체 요청·누락·오배송)이 의도대로 분류되는지,
# 기존 우선순위(해지 > 기기) 규칙이 보강 후에도 깨지지 않는지(회귀 방지) 검증한다.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from features.issues.classifier import classify, extract_symptom_fields


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
            assert (main, sub) == ("기기·하드웨어 오류", "기기 교체 요청"), memo

    # 보강된 누락·오배송 키워드
    def test_missing_delivery_keyword(self):
        main, sub = classify("영상 누락되어 재발송 안내")
        assert (main, sub) == ("교재·물류·배송", "누락·오배송")


class TestTemplateKeywords:
    # 템플릿 추출 후 새 키워드 매칭 검증
    def test_safe_mode_is_boot_error(self):
        memo = (
            "*확인사항 : 안전모드로 나온다는 문의\n"
            "- 상세증상 : 안전모드로 확인\n"
            "*안내 내용 : 강제재부팅 안내\n"
            "*후속관리 : 미진행"
        )
        main, sub = classify(memo)
        assert (main, sub) == ("기기·하드웨어 오류", "부팅 오류")

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

    # 같은 기기 대분류 안에서는 RULES 순서(충전이 기기 교체보다 앞)가 우선
    def test_swap_beats_charging_same_main(self):
        # 기기 교체 요청이 충전·전원 불량보다 우선 (원인 불문 교체 케이스 우선)
        main, sub = classify("충전이 안되어 학습기 교체 문의")
        assert (main, sub) == ("기기·하드웨어 오류", "기기 교체 요청")

    # 보강과 무관한 기존 분류는 그대로
    def test_existing_unchanged(self):
        assert classify("와이파이 연결이 안됨")[0] == "네트워크·앱 오류"
        assert classify("위약금 문의 주심")[1] == "해지금·위약금 문의"
        assert classify("") == (None, None)


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
        assert (main, sub) == ("기기·하드웨어 오류", "기기 교체 요청")

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
