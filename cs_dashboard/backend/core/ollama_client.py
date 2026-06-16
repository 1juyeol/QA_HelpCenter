# -*- coding: utf-8 -*-
# Ollama API 호출 유틸리티. 프로젝트 어디서든 Ollama를 쓸 때 이 모듈만 import한다.
# 관리하는 것: 서버 주소·모델명 상수, HTTP 호출, JSON 추출.
#
# 사용법:
#   from core.ollama_client import call_ollama, parse_json_response
#   raw = call_ollama(system="...", prompt="...")
#   data = parse_json_response(raw)  # dict 또는 None
#
# IP/모델 변경 시 이 파일의 상수 두 줄만 수정하면 된다.

import json
import os
import re
import httpx

# 환경변수 OLLAMA_BASE_URL / OLLAMA_MODEL 로 재정의 가능.
# 미설정 시 아래 기본값 사용.
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://192.168.10.221:4521")
OLLAMA_MODEL    = os.environ.get("OLLAMA_MODEL",    "gemma4:12b")


def call_ollama(system: str, prompt: str, timeout: int = 300) -> str:
    """Ollama /api/generate 스트리밍 호출. 토큰을 콘솔에 실시간 출력하며 전체 텍스트 반환. 실패 시 빈 문자열."""
    try:
        full = []
        print("[Ollama] 생성 중... ", end="", flush=True)
        with httpx.stream(
            "POST",
            f"{OLLAMA_BASE_URL}/api/generate",
            json={"model": OLLAMA_MODEL, "system": system, "prompt": prompt, "stream": True},
            timeout=timeout,
            verify=False,
        ) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                chunk = json.loads(line)
                token = chunk.get("response", "")
                print(token, end="", flush=True)
                full.append(token)
                if chunk.get("done"):
                    break
        print()  # 줄바꿈
        return "".join(full)
    except Exception as e:
        print(f"\n[Ollama] 호출 실패: {e}")
        return ""


def parse_json_response(text: str) -> dict | None:
    """LLM 응답 텍스트에서 JSON 블록 추출. 실패 시 None."""
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
