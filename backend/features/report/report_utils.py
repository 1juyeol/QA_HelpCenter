# -*- coding: utf-8 -*-
# 보고서 공통 상수·유틸. daily_client.py와 weekly_client.py가 함께 사용한다.
#
# 리스크 카테고리 정의:
#   RISK_MAIN     : 대분류 전체가 리스크인 카테고리 (네트워크·앱 오류, 기기·하드웨어 오류)
#   RISK_SPECIFIC : 소분류 단위로 리스크인 카테고리 (미납 관리, 해지 확정 등)
#   _MAIN_ORDER   : 보고서 표시 순서 (대분류 5개)
#   _is_risk()    : (main, sub) 조합이 리스크인지 판별
#
# Gemma 공통 프롬프트:
#   _SYSTEM_CATEGORY : 카테고리별 2문장 분석 시스템 프롬프트 (일별·주간 공용)
#
# describe_gemma_failure(): Gemma 응답에서 JSON을 못 뽑았을 때의 gemma_error 문자열을 만든다.
#   예전엔 "Gemma 응답 파싱 실패 또는 빈 응답"이라고만 남아서, 진짜 빈 응답이었는지 응답은
#   왔는데 내용이 이상했는지(예: 코드블록 기호 3글자만 옴) 서버 로그를 직접 봐야만 알 수
#   있었다. 응답 길이·앞부분 미리보기를 메시지에 바로 담아 감사 로그만 봐도 알 수 있게 한다.
#
# 프론트엔드 categories.ts의 ALLOWED_MAIN + ALLOWED_SPECIFIC와 동일하게 유지해야 한다.

INSUFFICIENT_SUMMARY = "구체적 증상 데이터가 충분하지 않아 분석에서 제외되었습니다."
_MIN_ANALYSIS_MEMOS = 3

RISK_MAIN = {"네트워크·앱 오류", "기기·하드웨어 오류"}
RISK_SPECIFIC = {
    "교재·물류·배송 > 기기 장기미회수",
    "교재·물류·배송 > 누락·오배송",
}

_MAIN_ORDER = [
    "네트워크·앱 오류",
    "기기·하드웨어 오류",
    "교재·물류·배송",
]


def _is_risk(main: str, sub: str) -> bool:
    if main in RISK_MAIN:
        return True
    return f"{main} > {sub}" in RISK_SPECIFIC


def describe_gemma_failure(raw: str) -> str:
    """Gemma가 호출은 성공했는데 응답에서 JSON을 못 찾았을 때(parse_json_response가 None)
    쓰는 gemma_error 메시지. 빈 응답과 "응답은 왔는데 내용이 이상함"을 구분해서 보여준다."""
    if not raw:
        return "Gemma 응답 없음 (빈 응답)"
    preview = " ".join(raw.split())[:80]
    return f'Gemma 응답에서 JSON을 찾지 못함 ({len(raw)}자: "{preview}")'


# 카테고리별 2문장 분석 시스템 프롬프트 — 일별(daily_client)과 주간(weekly_client) 공용
_SYSTEM_CATEGORY = (
    "당신은 단비교육 공감센터 CS 분석 전문가입니다.\n"
    "CS팀 운영이 아닌 개발·서비스 품질 관점에서 분석하세요.\n"
    "규칙: 코드 블록 없이 JSON만 출력\n"
    "규칙: Jira 이슈 번호, 배포 버전, 내부 시스템 ID 등 프롬프트에 없는 구체적 레퍼런스를 절대 언급하지 마세요.\n"
    "규칙: High/Medium/Low 등 우선순위 레이블을 사용하지 마세요.\n"
    "규칙: 제공된 메모에 직접 나타난 내용만 작성하세요. 원인 추론·권고사항·UX 개선 제안은 절대 하지 마세요.\n"
    "규칙: 해석이나 판단을 포함할 경우 반드시 '~로 보입니다', '~가능성이 있습니다', '~추정됩니다' 같은 추측 표현을 사용하세요. 단정적 원인 서술은 하지 마세요.\n"
    '응답 형식:\n{"summary": "두 문장 분석."}'
)
