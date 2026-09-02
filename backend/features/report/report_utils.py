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
#   _SYSTEM_CATEGORY : 카테고리별 최대 4문장 분석 시스템 프롬프트 (일별·주간 공용)
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
# "교재·물류·배송 > 기기 교체 요청"은 리스크에서 뺐다 — classifier.py의 사유 분석 이중로직으로
# 진짜 결함(충전·전원 불량 등)은 이미 실제 카테고리로 빠져나가고, 남는 건 대부분 상품·등급
# 전환·고객 요청형·학습 동기부여용 교체처럼 결함이 아니거나(40%+), 사유 자체를 모르는 것
# (35%+)이다. 결함일 근거가 약한데도 전부 리스크로 세면 리스크율이 실제보다 부풀려진다.

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


def gemma_detail(base: str, result: dict) -> str:
    """analyze-category/analyze-peak/analyze-anomaly 결과의 gemma_error·insufficient_data를
    감사 로그 detail 문자열에 반영한다. 실패해도 print()로만 사라지지 않고 여기 남는다.
    result가 빈 dict(예: 피크타임에 분석할 데이터 자체가 없음)면 실패가 아니라 "분석 대상 없음"으로
    구분해서 남긴다 — 안 그러면 "성공"으로 잘못 표시된다.
    elapsed(호출 소요시간)와 gemma_prompt(실제로 보낸 시스템+유저 프롬프트 전문)를 항상 같이
    남긴다 — RAG 게이트웨이가 프롬프트에 무관한 내용을 덧씌우는지 등은 감사 로그만 보고도
    확인할 수 있어야 docker 로그를 뒤질 필요가 없다. prompt는 줄바꿈·쉼표를 포함할 수 있어
    반드시 detail 문자열의 맨 끝에 둔다(프론트 parseDetail이 끝까지를 통째로 읽는다)."""
    if not result:
        return f"{base}, status=no_data"
    elapsed = result.get("elapsed")
    elapsed_part = f", elapsed={elapsed}" if elapsed is not None else ""
    err = result.get("gemma_error")
    if err:
        detail = f"{base}, status=failed{elapsed_part}, error={err}"
    elif result.get("insufficient_data"):
        count = result.get("analysis_count")
        if count is not None:
            reason = f"구체적 증상 데이터가 {count}건으로 분석 최소 기준({_MIN_ANALYSIS_MEMOS}건)에 못 미쳐 제외되었습니다."
        else:
            reason = INSUFFICIENT_SUMMARY
        detail = f"{base}, status=insufficient_data, reason={reason}{elapsed_part}"
    else:
        detail = f"{base}, status=success{elapsed_part}"
    prompt = result.get("gemma_prompt")
    if prompt:
        detail += f", prompt={prompt}"
    return detail


# 카테고리별 최대 4문장 분석 시스템 프롬프트 — 일별(daily_client) 전용. 주간(weekly_client)은
# report_weekly.py의 _SYSTEM_WEEKLY_CATEGORY를 따로 쓴다(둘 다 자동화 관리 화면에서 독립적으로
# 편집할 수 있어야 해서 상수 자체를 분리해뒀다 — 이 파일 상단 주석 참고).
# role/rules/example을 태그로 구분하고 few-shot 예시를 넣은 구조 — 예시 없이 규칙만 나열했을 때
# 원하는 출력 형태를 모델이 텍스트로만 추측해야 해서, 특정 입력에서 JSON을 열자마자
# 멈춰버리는(예: "{" 1글자) 실패가 있었다. 실제 출력 형태를 하나 보여주면 이런 실패가 줄어든다.
_SYSTEM_CATEGORY = (
    "<role>\n"
    "당신은 단비교육 공감센터의 CS 데이터 분석가입니다. 리스크 카테고리별 CS 상담 메모를 검토해서\n"
    "개발·서비스 품질팀이 우선 조사할 결함 패턴을 파악하는 요약을 작성합니다.\n"
    "</role>\n\n"
    "<rules>\n"
    "- JSON 객체 하나만 출력합니다. 백틱(`)이나 마크다운 코드 블록으로 감싸지 않습니다.\n"
    "- summary는 최대 4문장입니다. 사유가 적으면 그보다 짧아도 됩니다 — 불필요하게 문장 수를\n"
    "  채우지 마세요. 마지막 문장은 그 현상들이 사용자에게 미치는 영향 또는 왜 심각한지이고,\n"
    "  그 앞 문장(들)은 결함 사유를 언급합니다.\n"
    "- 제공된 메모에 실제로 나타난 내용만 씁니다. 원인 추론, 권고사항, UX 개선 제안은 쓰지 않습니다.\n"
    "- Jira 이슈 번호, 배포 버전, 내부 시스템 ID 등 메모에 없는 구체적 레퍼런스는 언급하지 않습니다.\n"
    "- High/Medium/Low 같은 우선순위 레이블은 쓰지 않습니다.\n"
    "- 해석·판단이 들어가면 '~로 보입니다', '~가능성이 있습니다', '~추정됩니다' 같은 추측 표현을\n"
    "  씁니다. 단정하지 않습니다.\n"
    "- 건수·비율 등 숫자는 절대 언급하지 않습니다('N건', '몇 건', '%' 모두 금지). 몇 건인지는\n"
    "  이미 화면에 정확히 표시되어 있으니, 당신은 메모를 직접 세거나 어림잡지 말고 어떤 유형의\n"
    "  문제들이 있는지만 서술합니다. '다수', '여러 건', '반복적으로' 같은 표현은 괜찮습니다.\n"
    "- CS 운영 조언은 쓰지 않습니다.\n"
    "- 상위 1개 증상만 언급하지 말고 **메모에 나타난 서로 다른 증상 유형을 최대한 많이(문장 수\n"
    "  한도 안에서)** 언급하세요. 1개만 언급하면 카테고리 내용이 매일 거의 고정되어 있어서\n"
    "  보고서가 매번 똑같은 내용처럼 보입니다.\n"
    "- 마지막 문장(영향·심각성)도 메모에 실제로 언급된 결과·조치(예: 사용 불가, 교체 요청,\n"
    "  재부팅 등)만 근거로 삼습니다. 메모에 없는 새로운 사건이나 용어(예: '시스템 정지',\n"
    "  '학습 진행 방해')를 만들어내지 않습니다.\n"
    "</rules>\n\n"
    "<example>\n"
    '{"summary": "충전이 되지 않거나 전원이 켜지지 않는 증상이 반복적으로 접수되고 있으며, 터치가 '
    '먹통이 되거나 화면에 이상이 생기는 경우도 확인됩니다. 이러한 결함으로 인해 학습기를 정상적으로 '
    '사용할 수 없는 상태로 이어지는 것으로 보입니다."}\n'
    "\n"
    "제공된 메모의 증상 유형이 1~2개뿐이면 그만큼만 짧게 씁니다:\n"
    '{"summary": "네트워크 연결이 불안정하다는 문의가 확인됩니다. 이 증상이 발생하면 화상 수업 중 '
    '연결이 끊겨 수업을 이어가기 어려운 것으로 보입니다."}\n'
    "</example>\n\n"
    "위 예시와 같은 형식으로, JSON 객체 하나만 출력하세요."
)
