# -*- coding: utf-8 -*-
# Gemma API 호출 유틸리티. 프로젝트 어디서든 Gemma를 쓸 때 이 모듈만 import한다.
# 관리하는 것: 서버 주소·모델명 상수, HTTP 호출, JSON 추출.
#
# 사용법:
#   from core.gemma_client import call_gemma, parse_json_response
#   raw = call_gemma(system="...", prompt="...")
#   data = parse_json_response(raw)  # dict 또는 None
#
# 런타임 URL 변경: set_gemma_url(url) 호출 → 즉시 반영 + gemma_settings.json 저장
# 서버 재시작 시 gemma_settings.json 이 있으면 저장된 URL로 시작, 없으면 기본값 사용.

import asyncio
import json
import os
import re
import time
from pathlib import Path
import httpx

GEMMA_MODEL = os.environ.get("GEMMA_MODEL", "gemma4:12b")

_DEFAULT_URL  = os.environ.get("GEMMA_BASE_URL", "http://192.168.11.131:1234")
_SETTINGS_FILE = Path(__file__).parent.parent / "gemma_settings.json"

def _load_saved_url() -> str:
    # 구 설정 파일(ollama_settings.json) 하위 호환 지원
    old_file = Path(__file__).parent.parent / "ollama_settings.json"
    for f in (_SETTINGS_FILE, old_file):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            return data.get("url") or _DEFAULT_URL
        except Exception:
            continue
    return _DEFAULT_URL

_current_url: str = _load_saved_url()
_gemma_lock = asyncio.Lock()


def get_gemma_url() -> str:
    return _current_url


def set_gemma_url(url: str) -> None:
    global _current_url
    _current_url = url
    _SETTINGS_FILE.write_text(json.dumps({"url": url}, ensure_ascii=False), encoding="utf-8")
    print(f"[Gemma] URL 변경됨: {url}")


async def check_gemma() -> bool:
    """Gemma 서버 연결 가능 여부 확인. 5초 내 응답 없으면 False."""
    try:
        async with httpx.AsyncClient(verify=False, timeout=5) as client:
            resp = await client.get(f"{get_gemma_url()}/api/tags")
            return resp.status_code == 200
    except Exception:
        return False


async def log_gemma_models() -> None:
    """서버 시작 시 Gemma 서버에 로드된 모델 목록 출력."""
    try:
        async with httpx.AsyncClient(verify=False, timeout=5) as client:
            resp = await client.get(f"{get_gemma_url()}/api/tags")
            models = resp.json().get("models", [])
        if models:
            print(f"[Gemma] 서버: {get_gemma_url()}")
            print(f"[Gemma] 요청 모델: {GEMMA_MODEL}")
            for m in models:
                print(f"[Gemma] 로드된 모델: {m['name']}")
        else:
            print(f"[Gemma] 서버 응답했으나 모델 없음 (URL: {get_gemma_url()})")
    except Exception as e:
        print(f"[Gemma] 서버 연결 실패: {e}")


async def _call_gemma_once(system: str, prompt: str) -> str:
    """Gemma 단일 호출. 빈 응답 포함한 원시 결과 반환."""
    full = []
    has_thinking = False
    http_timeout = httpx.Timeout(connect=30.0, read=None, write=30.0, pool=30.0)
    async with httpx.AsyncClient(verify=False, timeout=http_timeout) as client:
        async with client.stream(
            "POST",
            f"{get_gemma_url()}/api/generate",
            json={
                "model": GEMMA_MODEL,
                "system": system,
                "prompt": prompt,
                "stream": True,
                "think": False,
                # 0.7은 RAG 게이트웨이를 거치던 시절 "매번 똑같이 1글자만 뱉고 멈추는" 결정론적
                # 실패를 피하려고 올렸던 값 — 원본 서버로 바꾼 뒤로는 그 문제 자체가 없어졌다.
                # 반면 CS 요약처럼 메모에 없는 내용을 지어내면 안 되는 작업엔 0.7이 오히려
                # "그럴듯하지만 근거 없는 서술"을 만들 여지를 준다 — 0.3으로 낮춰 보수적으로 조정.
                "options": {"num_ctx": 8192, "temperature": 0.3},
            },
        ) as resp:
            resp.raise_for_status()
            first = True
            async for line in resp.aiter_lines():
                if not line:
                    continue
                chunk = json.loads(line)
                if first:
                    print(f"\n[Gemma] 실제 모델: {chunk.get('model', '?')}", flush=True)
                    first = False
                if chunk.get("thinking"):
                    has_thinking = True
                token = chunk.get("response", "")
                print(token, end="", flush=True)
                full.append(token)
                if chunk.get("done"):
                    break
    if has_thinking and not full:
        print("\n[Gemma] 경고: thinking 토큰만 수신, response 없음")
    return "".join(full)


async def _log_progress(start: float) -> None:
    """60초마다 경과 시간 출력. call_gemma에서 백그라운드 태스크로 실행."""
    while True:
        await asyncio.sleep(60)
        elapsed = int(time.time() - start)
        print(f"\n[Gemma] {elapsed // 60}분 경과...", flush=True)


_MIN_VALID_RESPONSE_LEN = 5  # 이보다 짧으면(예: "{" 1자, "```" 3자) 완성된 JSON일 수 없어 재시도 대상


async def call_gemma(system: str, prompt: str, timeout: int = 600) -> str:
    """Gemma /api/generate 비동기 스트리밍 호출. 빈 응답·1~4자짜리 잘린 응답이면 1회 재시도.
    동시 호출 방지 락 사용.
    예전엔 "완전히 빈 문자열"일 때만 재시도했는데, 실제 실패는 "{" 1글자처럼 완전히 빈 건
    아니라서 이 안전장치를 그냥 통과해버렸다 — 그래서 재시도 2번을 돌려도 매번 똑같이
    실패하는 것처럼 보였다(사실 재시도 자체가 발동을 안 한 것)."""
    async with _gemma_lock:
        try:
            start = time.time()
            print("[Gemma] 생성 중... ", end="", flush=True)
            progress = asyncio.create_task(_log_progress(start))
            try:
                result = await asyncio.wait_for(_call_gemma_once(system, prompt), timeout=timeout)
            finally:
                progress.cancel()
                try:
                    await progress
                except asyncio.CancelledError:
                    pass
            elapsed = time.time() - start
            print(f"\n[Gemma] 완료 ({elapsed:.1f}초) | 응답 길이: {len(result)}자")

            if len(result.strip()) < _MIN_VALID_RESPONSE_LEN:
                print(f"[Gemma] 경고: 응답이 너무 짧음({result!r}) — 1회 재시도")
                result = await asyncio.wait_for(_call_gemma_once(system, prompt), timeout=timeout)
                elapsed2 = time.time() - start
                print(f"\n[Gemma] 재시도 완료 ({elapsed2:.1f}초) | 응답 길이: {len(result)}자")
                if len(result.strip()) < _MIN_VALID_RESPONSE_LEN:
                    print(f"[Gemma] 경고: 재시도 후에도 응답이 너무 짧음({result!r})")

            return result
        except asyncio.CancelledError:
            print("\n[Gemma] 취소됨")
            raise
        except Exception as e:
            print(f"\n[Gemma] 호출 실패: {type(e).__name__}: {e}")
            return ""


def _unescape_literal_newlines(value):
    """Gemma가 가끔 JSON 문자열 안에 실제 줄바꿈 대신 리터럴 백슬래시+n 두 글자를 그대로
    출력하는 경우가 있다(같은 응답 안에서도 불릿 구분자 일부만 이렇게 깨짐) — json.loads()는
    스펙대로 정확히 파싱한 것이라 이건 파싱 버그가 아니라 모델 출력 자체의 문제다. 파싱 후
    문자열 값에 남아있는 리터럴 "\\n"을 실제 줄바꿈으로 바꿔서, 화면에 "\\n"이 그대로
    노출되는 걸 막는다."""
    if isinstance(value, str):
        return value.replace("\\n", "\n")
    if isinstance(value, dict):
        return {k: _unescape_literal_newlines(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_unescape_literal_newlines(v) for v in value]
    return value


def parse_json_response(text: str) -> dict | None:
    """LLM 응답 텍스트에서 JSON 블록 추출. 실패 시 None."""
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return None
    try:
        return _unescape_literal_newlines(json.loads(m.group(0)))
    except json.JSONDecodeError:
        return None
