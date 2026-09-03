# -*- coding: utf-8 -*-
# core/gemma_client.py의 parse_json_response() 유닛 테스트.
# 재현 버그: Gemma가 JSON 응답 안에서 불릿 구분자 중 일부만 실제 줄바꿈 대신 리터럴
# 백슬래시+n 두 글자("\n"이 아니라 "\\n")를 그대로 출력하는 경우가 있었다 — json.loads()
# 자체는 스펙대로 정확히 동작한 것이라(입력에 있는 그대로), 파싱 이후 문자열 값에서 그
# 리터럴 시퀀스를 실제 줄바꿈으로 바꿔주는 후처리가 필요했다. DB 조회 없이 실행 가능.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.gemma_client import parse_json_response


class TestParseJsonResponse:
    def test_extracts_plain_json(self):
        assert parse_json_response('{"summary": "hello"}') == {"summary": "hello"}

    def test_extracts_json_wrapped_in_extra_text(self):
        text = '여기 결과입니다:\n{"summary": "본문"}\n이상입니다.'
        assert parse_json_response(text) == {"summary": "본문"}

    def test_returns_none_when_no_json_found(self):
        assert parse_json_response("결과 없음") is None

    def test_returns_none_on_malformed_json(self):
        assert parse_json_response('{"summary": "본문"') is None

    def test_real_newline_in_json_stays_a_real_newline(self):
        # json.loads()가 "\n"(JSON 이스케이프)을 정상적으로 실제 줄바꿈으로 바꾼 경우 —
        # 정상 케이스이니 그대로 유지되어야 한다.
        result = parse_json_response('{"summary": "첫 줄\\n둘째 줄"}')
        assert result["summary"] == "첫 줄\n둘째 줄"

    def test_literal_backslash_n_in_response_is_converted_to_real_newline(self):
        # Gemma가 JSON 문자열 안에 리터럴 백슬래시+n 두 글자를 그대로 넣은 경우(원문 JSON에
        # 백슬래시가 두 번 나와 파싱 후에도 "\n" 두 글자가 남는 상황) — 화면에 "\n"이 그대로
        # 노출되지 않도록 실제 줄바꿈으로 바꿔야 한다.
        raw = '{"summary": "첫 줄\\\\n둘째 줄"}'
        result = parse_json_response(raw)
        assert result["summary"] == "첫 줄\n둘째 줄"

    def test_converts_nested_dict_and_list_values(self):
        raw = '{"rows": [{"text": "가\\\\n나"}], "meta": {"note": "다\\\\n라"}}'
        result = parse_json_response(raw)
        assert result["rows"][0]["text"] == "가\n나"
        assert result["meta"]["note"] == "다\n라"

    def test_non_string_values_untouched(self):
        result = parse_json_response('{"count": 5, "ok": true, "summary": "글"}')
        assert result == {"count": 5, "ok": True, "summary": "글"}
