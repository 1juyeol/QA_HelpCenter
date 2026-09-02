# -*- coding: utf-8 -*-
# 해지 사유 · 기기 교체 원인 분석 전용 집계 로직.
# classifier.py는 CS 메모를 카테고리로 "분류"만 하는 반면, 이 파일은 이미 분류된 두 카테고리
# (해지·유지 상담 / 기기 교체 요청) 안에서 "왜"에 해당하는 자유텍스트를 추출·집계한다.
#
# - extract_churn_reason(): "*해지요청 사유 : <내용>" 구조화 필드의 값을 추출한다 (없으면 None).
#   해당 필드가 없는 메모(전체의 약 85%)는 사유가 이질적인 자유 텍스트라 집계 대상에서 제외한다.
# - classify_churn_reason(): 추출된 사유 텍스트를 CHURN_REASON_RULES 키워드로 분류한다.
#   어느 키워드에도 안 걸리면 "사유 미상(단순 요청)"으로 분류 — 상담원이 사유를 남기지 않고
#   요청만 전달한 케이스로, 그 자체로 의미 있는 집계 결과다.
# - extract_device_model(): "*교체학습기 :" / "*교체 학습기 :" 필드에서 기종명을 추출한다.
#   전체 교체 요청의 약 93%가 이 필드를 가지고 있어 별도 분류 규칙 없이 그대로 집계 가능하다.
# - classify_device_swap_reason(): 기기 교체 메모 원문 전체를 DEVICE_SWAP_REASON_RULES 키워드로
#   스캔해 "왜" 교체됐는지 분류한다(고장 확인 vs 비고장 요청 vs 이력 없음). classify_churn_reason()과
#   달리 구조화 필드값이 아니라 memo 원문 전체를 검사한다 — 샘플링해보니 실제 증상 설명이
#   *확인사항 같은 라벨 필드가 아니라 *교체학습기 헤더 바로 아래 자유 텍스트로 적힌 경우가
#   많아서, 필드 추출보다 classifier.py의 RULES처럼 전체 텍스트 키워드 매칭이 더 안정적이었다.
#   어느 키워드에도 안 걸리면 실제 증상 텍스트가 남아있는지(_has_meaningful_reason_text)로
#   "이력 없음"(기록 자체가 없음)과 "사유 불명확"(적혀있지만 분류 불가)을 구분한다.
# - get_churn_reason_stats() / get_device_swap_stats(): core.db.get_conn()으로 issues 테이블을
#   스캔해 위 함수들로 만든 통계를 프론트에서 바로 쓸 수 있는 dict 형태로 반환한다.
import re
from collections import Counter

from core.db import get_conn
from features.issues.classifier import extract_symptom_fields

_HAEJI_REASON = re.compile(r"\*해지요청\s*사유\s*[:：]\s*(.+?)(?:\n\*|/\s*\*|\Z)", re.DOTALL)
_DEVICE_FIELD = re.compile(r"\*교체\s*학습기\s*[:：]\s*([^\n/]+)")

CHURN_REASON_RULES = [
    ("위약금·비용 부담", ["위약금", "비싸", "부담", "비용"]),
    ("타 서비스 이동", ["학원", "타사", "캐잉", "다른 학습지", "타 브랜드", "웅진", "교원", "재능", "눈높이", "빨간펜", "아이스크림", "씽크빅"]),
    ("환불·청약철회", ["환불", "청약철회", "청약 철회", "결제취소", "결제 취소"]),
    ("학습 흥미·효과 저하", ["흥미", "재미없", "효과", "하기 싫", "안 한다", "안한다", "하지 않"]),
    ("생활 변화(이사·전학 등)", ["이사", "전학", "휴학", "졸업", "입학"]),
]
CHURN_REASON_FALLBACK = "사유 미상(단순 요청)"
MAX_EXAMPLES = 30  # 프론트에 내려줄 카드당 예시 원문 개수 상한 — 나머지는 count로만 파악


def extract_churn_reason(memo: str) -> str | None:
    """*해지요청 사유 : <값> 필드의 값을 추출. 필드 없으면 None."""
    m = _HAEJI_REASON.search(memo)
    if not m:
        return None
    val = re.sub(r"\s+", " ", m.group(1)).strip()
    return val or None


def classify_churn_reason(reason: str) -> str:
    """추출된 해지 사유 텍스트를 CHURN_REASON_RULES로 분류."""
    for name, keywords in CHURN_REASON_RULES:
        if any(kw in reason for kw in keywords):
            return name
    return CHURN_REASON_FALLBACK


def extract_device_model(memo: str) -> str | None:
    """*교체학습기 : <기종> 필드의 기종명을 추출. 필드 없으면 None."""
    m = _DEVICE_FIELD.search(memo)
    if not m:
        return None
    val = m.group(1).strip().rstrip("/").strip()
    return val or None


# 별도 라인업처럼 보이지만 실제로는 같은 계열로 묶어서 보는 게 맞는 기종명. 집계 시에만
# 병합하고(extract_device_model 자체는 원문 그대로 반환) 통계에서만 합쳐서 보여준다.
_MODEL_ALIASES = {
    "윙크 캐릭터 단말기": "윙크 학습 단말기",
}


def normalize_device_model(name: str) -> str:
    """기종별 집계용 이름 정규화. _MODEL_ALIASES에 있으면 대표 기종명으로 합친다."""
    return _MODEL_ALIASES.get(name, name)


# 실제 하드웨어 결함으로 교체된 케이스. classifier.py RULES의 4개 하드웨어 카테고리 키워드를
# 기반으로 하되, 기기 교체 메모 샘플링에서 발견된 표기 변형(공백 유무 등)과 누락된 흔한 증상
# (재부팅반복 붙여쓰기, 네트워크·학습끊김 계열)을 보강했다.
_DEFECT_RULES = [
    ("충전·전원 불량", ["충전이 안", "충전 안", "충전도 안", "충전불량", "충전이안", "충전잘안", "충전 잘 안",
        "충전이 잘 안", "충전이 잘안", "충전안됨", "충전기 고장", "발열", "충전기 불량", "배터리 소모",
        "배터리가 빨리", "배터리가 금방", "밧데리가", "빨리 소모", "방전 빨리", "방전이 빠르", "방전된다",
        "뚝 떨어져", "종일충전해도", "충전이 되지 않았", "충전을 했는데도", "충전기가 안", "충전기 안됨",
        "충전이 되지 않", "충전이 되질", "충전이 너무 오래", "충전 불량", "충전 문제", "충전선", "아답터",
        "전원이 안", "전원안켜", "전원이 들어오지 않", "전원이 자주", "전원 작동이 되지", "여러번 눌러야",
        "안켜짐", "안 켜짐", "안켜진다", "켜지지도 않", "키면 바로 꺼짐", "바로 꺼짐", "바로 꺼진다",
        "꺼짐현상", "자꾸 꺼진다", "자꾸 꺼지고", "자꾸 꺼짐", "이유없이 자꾸 꺼짐", "혼자 꺼졌다",
        "저절로 꺼짐", "켜지지 않", "켜지지않", "켜지지가 않", "켜지지를 않", "전원버튼", "전원 불량",
        "전원 이상", "충전 불가", "충전 이상", "충전 오류", "충전이 원활하지", "충전이 되다", "충전이 0%",
        "빨리 닳아", "화면이 나가버", "꺼지는 현상", "들어오질 않", "전원 들어오지", "방전이 빠름",
        "꺼졌다 켜지", "바로 없어진다", "금방 없어진다", "빨리 방전", "갑자기 꺼짐", "안켜지",
        "웅웅소리", "웅웅 소리", "되었다 안되었다", "됐다 안됐다", "전원안들어와", "전원-안들어와",
        "로딩하다가 꺼짐", "꺼져버리는", "충전을 해도 안", "충전을 해도 잘 안", "바로 꺼지",
        "에러메세지", "에러 메시지", "전원이 종료", "계속 꺼진다", "충전이 잘 되지 않", "전원도 불량",
        "꺼져 버림", "학습중 꺼짐", "학습 중 꺼짐", "학습도중 꺼짐", "충전이 올라가지 않",
        "충전이 아무리 해도", "아무리 해도 안", "과열", "화면은 나오지 않", "화면이 나오지 않",
        "충전이 전혀 안", "완충해도", "바로 방전", "꺼집니다", "배터리급방전", "하루도 안간다",
        "화면꺼짐", "충전기를 빼면", "뜨거워진다", "뜨거워 진다", "계속 꺼짐", "충전속도가 느림",
        "충전속도 느림", "전원오류", "전원 오류", "방전이 급격", "충전 너무 안됨", "충전이 너무 안",
        "만에 방전", "배터리없다", "충전 아예 안", "바데리없음", "바데리 없음", "배터리가 없어서",
        "자주 꺼진다", "꺼져버리", "배터리소진", "빨리 닳음", "안나옴", "방전이 너무 빠르",
        "방전이 빨리됨", "방전이 빨리", "그냥 꺼짐", "그냥 꺼진다", "배터리 빠름", "배터리빠름",
        "떳다 안떳다", "꽂는 부분 이상", "충전기 꽂는 부분", "충전이 아예 안", "충전기가 뜨거워",
        "너무 뜨거워", "자석타입 잘 안", "충전을 아무리", "혼자 꺼지", "전원 안들어옴", "전원안들어옴",
        "완전 꺼진다", "완전꺼짐", "배터리 불량", "자동으로 꺼짐", "전원이 자동으로 꺼짐",
        "밀착되지 않", "충전 접촉이 잘 안", "접촉이 잘 안", "충전오래가지 않", "오래가지 않",
        "갑자기 꺼진다", "단자가 고장", "충전도 잘 안", "충전이 불량",
        "저절로 전원", "다른충전기로도", "다른 충전기로도", "충전 인식 전혀", "완충되어있는데",
        "급격하게 방전", "개인충전기로도", "계속 방전됨", "충전 불편으로 교체", "충전이 많이 느림",
        "방전 직전", "충전기도 뜨겁고", "전원 충전 인식",
        # 아래 두 개는 짧은 어간(활용형 전체를 커버)이라 예외적으로 넣었다 — "기기 교체 요청"으로
        # 이미 확정된 8천여 건 안에서만 쓰이는 좁은 범위라 안전한지 실제로 샘플 검증했다.
        "뜨겁", "뜨거"]),
    ("터치·입력 불량", ["터치오류", "터치 오류", "고스트터치", "고스트 터치", "자동터치", "화면 깨", "액정",
        "화면불량", "화면 지지직", "지지직거림", "깜빡깜빡", "검은 줄", "하얀 화면", "화면이 안나오",
        "화면이 어두", "화면 흔들림", "볼륨키", "볼륨버튼", "볼륨휠", "볼륨이상", "볼륨 조절", "볼륨 불량",
        "소리불량", "소리조절", "소리 조절", "소리가 나지 않", "터치가 안됨", "터치가 안된다", "터치 불량",
        "터치도 잘 안", "좌표가 생긴다", "터치 안됨", "터치안됨", "터치가 안된", "키보드가 안됨",
        "키보드 안됨", "키보드가 안된다", "키보드가 되지 않", "키보드연결안됨", "키보드 연결",
        "키보드 미작동", "키보드 작동 안", "인식이안되", "눌러지지 않", "안눌림", "안눌러짐",
        "파란색줄", "줄이 생기는", "터치가 잘 안", "터치가 잘 되지 않", "먹통", "입력이 안됨",
        "입력이 안된다", "입력이 되지 않", "화면이 하얗", "자판이 잘 안", "터치가 안먹", "터치 안먹",
        "화면은 안나오", "화면이 깜빡", "화면 깜빡", "오입력", "자동입력됨", "터치가 안되", "인식안됨",
        "하울링", "노이즈", "안먹힘", "볼륨이 조절", "입력안됨", "화면 넘어가지 않", "화면이 넘어가지 않",
        "눌리지 않", "화면이 흔들리", "인식 불가", "터치가 되지 않", "음향불량", "소리가 새",
        "소리 울림", "음량이 작아", "블랙화면", "소리가 끊김", "소리가 계속 끊", "안눌러지",
        "제멋대로 움직", "터치가 많이 안", "드래그 안됨", "드래그가 안", "볼륨 조정버튼",
        "조정버튼이 안", "안 넘어간다", "안 들린다", "안나온다", "화면 안보임", "화면이 안보임",
        "오작동", "터치 안되", "고스터터치", "화면이 까맣게", "줄이 보임", "화면에 줄", "wifi 연결",
        "카메라가 흐릿", "흐릿하다", "안눌리는", "안눌리", "두개가 같이 눌린다", "키가 같이 눌린다",
        "소리가 끊겨", "헛돈다", "검은화면", "터치가 제대로 안", "휠이 말을 안들어", "말을 안들어",
        "작동 안됨", "타자 안쳐", "마음대로 움직", "빛반사", "터치 잘 안", "안눌러진다", "자판이 안되",
        "하얗게 나왔다가", "뿌옇게 보임", "뿌연 화면", "울림 현상", "화면 정지", "블루스크린",
        "안들림", "소리안들림", "선같은 것이 생긴다", "화면에 선",
        "키보드 누락", "키보드불량", "볼륨때문에", "작동이 되지 않", "키보드 빠짐", "터치가 안될 때",
        "터치도 안되고", "버튼이 그냥 눌러지고", "볼륨 다이얼이 느슨", "볼륨 돌리는 부분",
        "조작이안되는데", "터치 인식", "눌러지지도 않는다", "화면이 나갔다고", "화면이 들어오지 않",
        "가로줄", "화면이 어두움", "깜박거려", "들뜸", "화면이 그냥 자동으로 바뀌고", "파란줄",
        "화면줄", "화면이 반으로 갈라", "흔들린다", "흔들려서",
        # 짧은 어간(활용형 전체 커버) — 위 "뜨겁"과 같은 이유로 예외 추가, 샘플 검증 완료.
        "흔들", "볼륨"]),
    # 원래 속도·로딩류 키워드("너무 느려" 등)가 이 목록에 섞여 있었다 — "부팅 오류"는
    # 안 켜짐/재부팅을 뜻하는데, 속도 저하는 다른 증상이라 의미가 안 맞았다(classify()의
    # override 대상이 되면서 실제 카테고리 오배정으로 이어져 테스트로 드러남). 재부팅/부팅
    # 관련만 남기고 속도·로딩류는 전부 "학습 끊김·멈춤"으로 옮겼다.
    ("부팅 오류", ["부팅 반복", "부팅반복", "재부팅 반복", "재부팅반복", "재부팅해야", "학습기가 재부팅",
        "기기가 재부팅", "자동재부팅", "부팅이 잘안됨", "부팅이 잘 안됨", "select boot", "리커버리",
        "셀렉트 부트", "셀렉트부트", "안전모드", "계속 재부팅", "혼자 재부팅", "튕겨서 나감",
        "재부팅이 잘 안", "재부팅도 잘 안", "연속 재부팅", "자동으로 튕기", "잦은 재부팅",
        "학습 튕김", "재부팅 아무리", "부팅불량", "부팅이 너무 오래", "부팅이 안된다", "부팅이 안됨",
        "강제부팅을 하면", "강제재부팅후에도동일", "계속 꺼지고 재부팅됨", "재부팅해도 해결안됨",
        "매번 재부팅을 해야", "저절로 재부팅", "전원재부팅현상", "부팅이 잘 안되어"]),
    ("기기 파손", ["물을 쏟", "낙하 파손", "파손비용", "파손 비용", "손망실", "망실", "학습기 분실",
        "분실비용", "분실 비용", "파손 시트", "파손 >>", "파손>>", "파손 OB", "파손 콜", "파손콜",
        "LCD 파손", "파손", "발 빠짐", "벌어진다", "벌어짐", "헐거워", "달그락", "덜그럭", "나사가 빠졌",
        "경첩", "케이블이 망가", "부러진", "충전코드가 부러", "부풀어", "프레임이 안맞", "고정이 안되",
        "거꾸로 보인다", "충전기 분실", "버튼이 뻑뻑", "키가 빠짐", "키보드 하나가 빠짐", "깨져서",
        "키보드가 떨어진다", "하나씩 떨어진다", "접합부 탈락", "헐거움", "고무가 빠져서",
        "미끄러져서", "발이 빠져서", "발 한쪽이 빠져", "벌어졌다", "흔들거려서", "자판이 흔들",
        "벌어지고 있", "벌어져서", "벌어지는", "케이스가 벌어지고", "옆이 벌어져", "이음새 빠짐",
        "받침 하나가 빠짐", "터치패널이 벌어지고", "힌지 부분이 벌어져", "나사 2개가 빠짐",
        "나사가 빠져서", "나사가 풀",
        # 짧은 어간(활용형 전체 커버) — "뜨겁"과 같은 이유, 샘플 검증 완료.
        "벌어"]),
    ("네트워크·연결 불량", ["인터넷연결", "인터넷 연결", "와이파이", "웹페이지", "웹페이즐", "웹사이트 연결",
        "네트워크 연결이 안", "통화 연결이 되지", "연결이 잘 안", "연결도 잘안", "연결안됨",
        "지연이 발생"]),
    ("학습 끊김·멈춤", ["학습끊김", "학습 끊김", "학습이 멈추", "학습 멈춤", "학습기 멈춤", "화면 멈춤",
        "화면이 멈추", "앱이 멈추", "먹통이 되", "끊김 현상", "끊김현상", "끊김이 심해", "끊김이 있어서",
        "자주 멈춘다", "자주 멈춤", "컨텐츠 멈춤", "기기가 멈춰", "작동이안된다", "작동이 안",
        "자꾸 멈추", "끊어진다", "자꾸 끊어", "학습기 끊김", "끊김 멈춤", "자꾸 끊", "자주 끊기",
        "버퍼링", "중간에 끊기", "자꾸 멈춤", "자주 멈추", "끊김이 많아", "끊기고 멈추", "자꾸 멈춰",
        "보다가 멈추", "계속 멈춰", "계속 멈춤", "끊김이 심하", "멈춤 현상", "멈추는 현상",
        "계속 멈춘다", "로딩이 너무 오래", "로딩시간이 너무", "로딩 매우 길다", "로딩 오래",
        "로딩도 느리고", "기기가 느림", "기기 속도가 느림", "느려져서", "느리고,멈추고",
        "기기가 로딩이 심하고", "기기 노후로 로딩", "로딩이 길고", "렉 걸리고", "끊기고 버벅거리는",
        "버벅인다",
        # 짧은 어간(활용형 전체 커버) — "뜨겁"과 같은 이유, 샘플 검증 완료.
        "느리", "느려",
        # "부팅 오류"에서 옮겨옴 — 의미상 재부팅/부팅 실패가 아니라 속도·로딩 저하라 여기가 맞다.
        "다음화면으로 안넘어가", "로딩이 느림", "로딩이 너무 느", "로딩만 걸림", "로딩 길고",
        "학습기가 느리다", "기기가 느리다", "처음으로 돌아가", "랙걸림", "로딩이 오래",
        "화면이 바뀌지 않", "화면에서 바뀌지 않", "로딩이 길어", "너무 느려", "처음부터 다시",
        "로딩시간이 길", "로딩 증상", "기기가 느리고", "오류가 잦아", "기기가 느려", "버벅거려서",
        "버벅거림", "랙이 걸림", "랙이 자주 걸림", "너무 느림", "너무 느리", "느려서", "로딩 자꾸",
        "에러가 많이", "학습기 느리고", "무한 로딩", "홈화면으로 안 돌아가", "지속오류",
        "지속적인 오류", "로딩느려", "속도 느림", "속도느림", "오류가 잦게", "로딩이 느리고",
        "안넘어감", "안 넘어감", "로딩 느림", "로딩느림", "학습기가 느리고", "업데이트지속",
        "느림 증상"]),
    ("전원 On/Off 불량", ["꺼졌다 켰", "켜졌다 꺼", "켜고 끄는", "끄고 킬때", "끄고 킬 때", "켜고 끄고",
        "켜지고 꺼지고", "꺼도 안꺼진", "종료되지 않", "스스로 켜지", "켜지다 꺼지",
        "껐다 켜야", "껏다 켜야", "켜지지도 꺼지지도", "온오프 버튼", "꺼졌다켜졌다", "꺼지지 않는"]),
    ("소프트웨어·업데이트 오류", ["펌웨어 업데이트", "업데이트가 진행되지", "업데이트가 안", "업데이트 오류",
        "무상업그레이드", "업그레이드", "앱고정", "앱중지", "앱이 중지", "판서기능이 안",
        "원활하지 않", "원할하지 않", "학습이 뜨지 않", "학습이 안뜸", "학습안뜸", "뜨질 않는",
        "시스템을 로드", "알람 기능", "임시저장이 안", "재로그인 안됨"]),
]

# 고장이 아니라 고객 요청·컴플레인·상품(등급) 전환·학습 동기부여용으로 교체된 케이스.
# 오탐(false positive) 위험이 커서 애매한 표현("변심", "재교체" 단독 등)은 빼고,
# 메모에 사유가 명시적으로 남은 경우만 골랐다.
_CUSTOMER_REQUEST_RULES = [
    ("고객 요청형(비고장)", ["최신기종", "최신 기종", "컴플레인", "클레임", "강성 불만", "★강성", "화가 많이",
        "학부모요청", "학부모 요청", "학부모님 요청", "학부모님요청", "어머니 요청", "어머님 요청",
        "어머님요청", "고객요청", "고객 요청", "아이가 원함", "아이가원함", "같은 기기",
        "부모님 요청", "부모님요청"]),
    ("상품·등급 전환", ["프라임", "프리미엄", "정회원", "그룹수업", "그룹코칭", "화상수업 위해", "오리진 체험",
        "초등교과", "캐츠홈", "캐츠연결", "캐츠결합", "타자연습", "자모음", "예비초", "단과로 변경",
        "캐츠 학습", "상품변경"]),
    ("학습 동기부여용 교체", ["흥미 유발", "동기 부여", "학습흥미를 잃어", "학습흥미 유도", "학습 거부",
        "흥미가 떨어", "흥미떨어짐", "흥미 떨어", "학습 흥미", "분위기전환", "분위기 전환", "학습독려",
        "수행률저조", "수행율 저하", "학습 리프레쉬", "학습 안하려고", "분위기 쇄신", "흥미를 잃음",
        "정체기"]),
]

DEVICE_SWAP_REASON_RULES = _DEFECT_RULES + _CUSTOMER_REQUEST_RULES
DEVICE_SWAP_REASON_NO_HISTORY = "이력 없음"
DEVICE_SWAP_REASON_UNCLEAR = "사유 불명확"

# classifier.py의 classify()가 "기기 교체 요청"을 실제 결함 카테고리로 대신 확정할 때 쓰는
# 매핑 — 아래 classify_device_swap_reason()이 돌려주는 사유 이름 중, 실제 (대분류, 소분류)로
# 1:1 대응되는 것만 넣는다. "소프트웨어·업데이트 오류"는 샘플 검증 결과 상품·등급 전환("7세
# 업그레이드", "프라임 업그레이드 혜택" 등)이 섞여 있어 품질 검증 전까지 제외한다.
REASON_TO_CATEGORY = {
    "충전·전원 불량": ("기기·하드웨어 오류", "충전·전원 불량"),
    "터치·입력 불량": ("기기·하드웨어 오류", "터치·입력 불량"),
    # "부팅 오류"는 classifier.py에서 "충전·전원 불량"에 흡수됐다(건수가 적고 전원 계열 증상과
    # 섞여 언급되는 경우가 많아서) — 여기 사유 이름은 그대로 두고 매핑 대상만 맞춘다.
    "부팅 오류": ("기기·하드웨어 오류", "충전·전원 불량"),
    "기기 파손": ("기기·하드웨어 오류", "분실, 파손"),
    "학습 끊김·멈춤": ("네트워크·앱 오류", "학습 끊김·멈춤"),
    "네트워크·연결 불량": ("네트워크·앱 오류", "와이파이 오류"),
    "전원 On/Off 불량": ("기기·하드웨어 오류", "충전·전원 불량"),
}

# 문자열 키워드로 못 잡은 사유를 형태소(어간) 단위로 한 번 더 시도한다. 한국어는 활용형이
# 다양해서("벌어짐"/"벌어지고 있음"/"벌어져서") 문자열 그대로는 다 못 잡는데, 동사·형용사
# 어간은 활용형과 무관하게 항상 동일하게 추출된다(kiwipiepy 형태소 분석, stats_endpoints.py
# keyword_trend가 쓰는 것과 같은 라이브러리). "기기 교체 요청"으로 이미 확정된 좁은 범위
# (8천여 건) 안에서만 호출된다는 전제로 골랐다 — "터치"/"재부팅"처럼 이 범위 밖에서는 물류
# 처리·이미 해결된 사례까지 잡히는 다의어는 여기 넣지 않는다(실제 샘플로 확인함).
_STEM_TO_DEFECT_REASON = {
    "벌어지": "기기 파손", "부러지": "기기 파손", "깨지": "기기 파손", "헐겁": "기기 파손",
    "부풀": "기기 파손",
    "흔들리": "터치·입력 불량", "먹히": "터치·입력 불량",
    "뜨겁": "충전·전원 불량", "꺼지": "충전·전원 불량", "닳": "충전·전원 불량",
    "더디": "충전·전원 불량", "꽂히": "충전·전원 불량",
    "느리": "학습 끊김·멈춤", "끊기": "학습 끊김·멈춤",
    "튕기": "부팅 오류",
}
_NOUN_TO_DEFECT_REASON = {"방전": "충전·전원 불량"}

_kiwi = None


def _get_kiwi():
    global _kiwi
    if _kiwi is None:
        from kiwipiepy import Kiwi
        _kiwi = Kiwi()
    return _kiwi


def _classify_by_morpheme(cleaned: str) -> str | None:
    """어간 매칭으로 사유를 찾으면 그 이름을, 못 찾으면 None을 돌려준다."""
    kiwi = _get_kiwi()
    for analysis in kiwi.analyze([cleaned]):
        for tok in analysis[0][0]:
            if tok.tag in ("VV", "VA") and tok.form in _STEM_TO_DEFECT_REASON:
                return _STEM_TO_DEFECT_REASON[tok.form]
            if tok.tag == "NNG" and tok.form in _NOUN_TO_DEFECT_REASON:
                return _NOUN_TO_DEFECT_REASON[tok.form]
    return None

# 실제 하드웨어 결함 사유 이름 집합. 상품 전환·고객 요청·사유 불명확 등은 "사유가 명확하냐"와는
# 별개로 결함이 아니라서, 개발팀에 전달할 "결함 패턴" 요약에서는 여기 없는 이름은 제외해야 한다.
DEVICE_SWAP_DEFECT_REASONS = {name for name, _ in _DEFECT_RULES}

# 비용 절감 관점에서 실제로 들여다볼 필요가 있는 사유들. 기준은 "고장이냐 아니냐"가 아니라
# "사유 자체를 알 수 있느냐" — 학습 동기부여용 교체는 고장은 아니지만 사유가 명확히 적혀있으므로
# "사유 명확" 쪽이다. 반대로 이력없음·사유불명확·고객 요청형(비고장)은 사유를 알 수 없거나
# 고장 없이 요청·클레임만으로 바뀐 것이라 검토 대상으로 본다.
DEVICE_SWAP_REASON_NEEDS_REVIEW = {
    DEVICE_SWAP_REASON_NO_HISTORY, DEVICE_SWAP_REASON_UNCLEAR,
    "고객 요청형(비고장)",
}


def device_swap_reason_tier(name: str) -> str:
    """사유 이름 하나를 "clear"(사유 명확)/"needs_review"(확인 필요)로 나눈다."""
    return "needs_review" if name in DEVICE_SWAP_REASON_NEEDS_REVIEW else "clear"

# 교체 사유 판별에 쓰이는 boilerplate 문구·라벨. 이것만 빼고 남는 텍스트가 없으면
# "실제 사유 기록이 아예 없다"(이력 없음)고 본다. 상담원이 매번 묻는 점검 체크리스트
# ("- 충전기 딸깍 소리나게 꽉 꽂았는지 : ", "- 충전기 연결상태에서 전원버튼 딸깍 눌렀을 때...")는
# 답변이 비어 있어도 질문 문구 자체에 "전원버튼" 같은 키워드가 들어있어, 답 없이 질문만 남은
# 줄까지 걷어내지 않으면 실제로는 확인 안 된 항목이 "충전·전원 불량"으로 오분류된다.
# 라벨 길이 제한을 두지 않은 이유: 이 체크리스트 질문 문구 자체가 20자를 훌쩍 넘는다.
_BOILERPLATE_PHRASES = ["선출고 후회수 안내", "후속관리", "미진행", "고객과실로 판단될 시 비용발생됨 안내",
    "부재종결처리되었습니다", "부재로 종결되었습니다"]
# 라벨 문자 클래스에 ","를 추가한 이유: "단말기, 공유기 재부팅 시 동일현상 발생여부 : "처럼
# 라벨 안에 쉼표가 들어간 체크리스트 질문이 있어, 쉼표를 허용하지 않으면 이 줄이 안 걸러진다.
_LABEL_EMPTY_LINE_RE = re.compile(r"^[\-–]?\s*\*?[가-힣A-Za-z0-9/·(), ]+[:：]\s*$", re.MULTILINE)
_DEVICE_HEADER_LINE_RE = re.compile(r"\*교체\s*학습기\s*[:：][^\n]*")
# 인터넷 속도측정 결과는 진단용 수치일 뿐 교체 사유가 아니라서, 값이 있어도(빈 줄이 아니어도)
# 통째로 걷어낸다 — 안 걷어내면 "실제 기록이 있다"고 오판해 사유 불명확 대신 잘못 통과된다.
_SPEED_TEST_LINE_RE = re.compile(
    r"^\*?인터넷\s*속도측정.*$|^[\-–]?\s*(다운로드|업로드|지연시간|손실률)\s*[:：].*$",
    re.MULTILINE,
)


def clean_memo_for_reason(memo: str) -> str:
    """교체 사유 판별 전에 기종 필드·boilerplate 문구·답 없는 체크리스트 질문 줄을 제거한다.
    분류(classify_device_swap_reason)와 "실제 기록 있음" 판정(_has_meaningful_reason_text)이
    같은 정제된 텍스트를 봐야 체크리스트 질문 문구 때문에 생기는 오분류를 둘 다 막을 수 있다.
    report_daily.py의 '기기 교체 요청' 예시 생성에서도 재사용한다 — "동글 연결 불가능"처럼
    모든 메모에 박힌 고정 기종 헤더 문구가 원문 그대로 Gemma 프롬프트에 들어가면, 실제로는
    없는 증상을 있는 것처럼 요약해버리는 문제가 있었다."""
    text = _DEVICE_HEADER_LINE_RE.sub("", memo)
    text = _SPEED_TEST_LINE_RE.sub("", text)
    for phrase in _BOILERPLATE_PHRASES:
        text = text.replace(phrase, "")
    return _LABEL_EMPTY_LINE_RE.sub("", text)


def _has_meaningful_reason_text(cleaned: str) -> bool:
    """정제된 텍스트에 실제 내용이 남아있는지 확인. 10자 미만이면 상담원이 증상을
    아예 기록하지 않은 것으로 본다."""
    remaining = re.sub(r"[\s\-–*]", "", cleaned)
    return len(remaining) >= 10


def classify_device_swap_reason(memo: str) -> str:
    """기기 교체 메모를 DEVICE_SWAP_REASON_RULES로 스캔해 교체 사유를 분류한다.
    "전원 버튼"/"전원버튼"처럼 띄어쓰기만 다른 표현을 같이 잡기 위해, 키워드·본문 양쪽에서
    공백을 지운 뒤 비교한다. 매칭되는 키워드가 없으면 실제 증상 기록 유무에 따라
    "이력 없음"/"사유 불명확"으로 나눈다."""
    cleaned = clean_memo_for_reason(memo)
    normalized = re.sub(r"\s+", "", cleaned)
    for name, keywords in DEVICE_SWAP_REASON_RULES:
        matched_kws = [kw for kw in keywords if re.sub(r"\s+", "", kw) in normalized]
        if not matched_kws:
            continue
        # "파손비용"/"파손 비용"/bare "파손"은 실제 파손뿐 아니라 아직 파손되지 않았는데
        # 향후 정책을 미리 안내하는 문구("파손시 파손비용 발생 안내드림")에도 쓰인다.
        # "파손시"(조건문)와 함께 이 애매한 표현만 걸렸다면(다른 구체적 파손 키워드가 없다면)
        # 아직 일어나지 않은 일에 대한 안내일 뿐이므로 이 사유로 확정하지 않고 다음 후보를 본다.
        if name == "기기 파손" and "파손시" in cleaned:
            if all(k in ("파손비용", "파손 비용", "파손") for k in matched_kws):
                continue
        return name
    morph_reason = _classify_by_morpheme(cleaned)
    if morph_reason:
        return morph_reason
    return DEVICE_SWAP_REASON_UNCLEAR if _has_meaningful_reason_text(cleaned) else DEVICE_SWAP_REASON_NO_HISTORY


def find_defect_matched_keyword(memo: str) -> str | None:
    """classify_device_swap_reason()과 같은 순서로 훑되, 사유 이름 대신 실제로 걸린 키워드
    (또는 형태소 어간)를 그대로 돌려준다. classifier.py의 find_matched_keyword()가 관리자
    화면 "매칭 키워드" 컬럼에서, 이 이중로직으로 재분류된 건에 대해서도 근거를 보여줄 때 쓴다.
    형태소로 잡힌 경우는 "벌어지(형태소)"처럼 구분해서, 원문에 그 글자 그대로 없는데도
    걸렸다는 걸 눈으로 알 수 있게 한다."""
    cleaned = clean_memo_for_reason(memo)
    normalized = re.sub(r"\s+", "", cleaned)
    for _, keywords in DEVICE_SWAP_REASON_RULES:
        for kw in keywords:
            if re.sub(r"\s+", "", kw) in normalized:
                return kw
    kiwi = _get_kiwi()
    for analysis in kiwi.analyze([cleaned]):
        for tok in analysis[0][0]:
            if tok.tag in ("VV", "VA") and tok.form in _STEM_TO_DEFECT_REASON:
                return f"{tok.form}(형태소)"
            if tok.tag == "NNG" and tok.form in _NOUN_TO_DEFECT_REASON:
                return f"{tok.form}(형태소)"
    return None


def get_churn_reason_stats() -> dict:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, datetime(created_date, '+9 hours') AS kst_date, call_memo
            FROM issues
            WHERE new_category_main = '해지·유지 상담' AND call_memo LIKE '%해지요청 사유%'
            """
        ).fetchall()

    buckets: dict[str, list[dict]] = {}
    for r in rows:
        reason = extract_churn_reason(r["call_memo"])
        if reason is None:
            continue
        bucket = classify_churn_reason(reason)
        buckets.setdefault(bucket, []).append({
            "id": r["id"],
            "created_date": r["kst_date"],
            "reason": reason,
        })

    total = sum(len(items) for items in buckets.values())
    return {
        "total": total,
        "buckets": [
            {
                "name": name,
                "count": len(items),
                "examples": sorted(items, key=lambda x: x["created_date"], reverse=True)[:MAX_EXAMPLES],
            }
            for name, items in sorted(buckets.items(), key=lambda kv: -len(kv[1]))
        ],
    }


def get_device_swap_stats() -> dict:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, datetime(created_date, '+9 hours') AS kst_date, call_memo
            FROM issues
            WHERE new_category_sub = '기기 교체 요청'
            """
        ).fetchall()

    model_counts: Counter = Counter()
    model_rows: dict[str, list[dict]] = {}
    reason_counts: Counter = Counter()
    reason_rows: dict[str, list[dict]] = {}
    seonchulgo_count = 0
    for r in rows:
        memo = r["call_memo"] or ""
        model = normalize_device_model(extract_device_model(memo) or "기종 미상")
        is_seonchulgo = "선출고" in memo
        if is_seonchulgo:
            seonchulgo_count += 1
        model_counts[model] += 1
        model_rows.setdefault(model, []).append({
            "id": r["id"],
            "created_date": r["kst_date"],
            "seonchulgo": is_seonchulgo,
            "memo": memo,
        })

        reason = classify_device_swap_reason(memo)
        reason_counts[reason] += 1
        reason_rows.setdefault(reason, []).append({
            "id": r["id"],
            "created_date": r["kst_date"],
            "memo": memo,
        })

    total = len(rows)
    return {
        "total": total,
        "seonchulgo_count": seonchulgo_count,
        "normal_count": total - seonchulgo_count,
        "models": [
            {
                "model": name,
                "count": count,
                "examples": [
                    {**{k: v for k, v in item.items() if k != "memo"}, "reason": extract_symptom_fields(item["memo"])}
                    for item in sorted(model_rows[name], key=lambda x: x["created_date"], reverse=True)[:MAX_EXAMPLES]
                ],
            }
            for name, count in model_counts.most_common()
        ],
        "reasons": [
            {
                "name": name,
                "count": count,
                "tier": device_swap_reason_tier(name),
                "examples": [
                    {**{k: v for k, v in item.items() if k != "memo"}, "reason": extract_symptom_fields(item["memo"])}
                    for item in sorted(reason_rows[name], key=lambda x: x["created_date"], reverse=True)[:MAX_EXAMPLES]
                ],
            }
            for name, count in reason_counts.most_common()
        ],
    }
