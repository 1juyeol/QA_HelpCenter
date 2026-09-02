# -*- coding: utf-8 -*-
# 상담 메모(call_memo) 원문에 있는 전화번호를 마스킹한다.
# DB의 call_memo 원본은 절대 건드리지 않는다 — 화면에 보여주거나 Gemma 프롬프트에 넣기
# 직전, 딱 그 시점에만 이 함수를 거친다(호출부 각각이 알아서 적용).
#
# 010-1234-5678 → 010-xxxx-5678, 01012345678 → 010xxxx5678.
# 앞뒤에 다른 숫자·영문자가 붙어있으면(예: 기기 시리얼 번호, 티켓 번호) 제외한다 — 전화번호가
# 아닌 숫자열 중간에 우연히 "010..." 패턴이 들어있는 경우까지 잘못 마스킹하는 걸 막기 위함.
# 실제 데이터(전체 이슈 81,674건)로 경계 조건 없이/있이 검증함: 없이는 기기 시리얼 번호
# ("WD10191100323")까지 마스킹 대상으로 걸렸고, 경계 조건을 넣은 뒤 391건 전수 확인 결과 오탐 0건.
import re

_PHONE_HYPHEN = re.compile(r"(?<![0-9A-Za-z])(01[016789])-(\d{3,4})-(\d{4})(?![0-9A-Za-z])")
_PHONE_NO_HYPHEN = re.compile(r"(?<![0-9A-Za-z])(01[016789])(\d{3,4})(\d{4})(?![0-9A-Za-z])")


def mask_phone_numbers(text: str | None) -> str | None:
    if not text:
        return text
    text = _PHONE_HYPHEN.sub(lambda m: f"{m.group(1)}-xxxx-{m.group(3)}", text)
    text = _PHONE_NO_HYPHEN.sub(lambda m: f"{m.group(1)}xxxx{m.group(3)}", text)
    return text
