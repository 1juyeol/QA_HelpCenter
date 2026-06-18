# -*- coding: utf-8 -*-
# Ollama API 호출 유틸리티. 프로젝트 어디서든 Ollama를 쓸 때 이 모듈만 import한다.
# 관리하는 것: 서버 주소·모델명 상수, HTTP 호출, JSON 추출.
#
# 사용법:
#   from core.ollama_client import call_ollama, parse_json_response
#   raw = call_ollama(system="...", prompt="...")
#   data = parse_json_response(raw)  # dict 또는 None
#
# 런타임 URL 변경: set_ollama_url(url) 호출 → 즉시 반영 + ollama_settings.json 저장
# 서버 재시작 시 ollama_settings.json 이 있으면 저장된 URL로 시작, 없으면 기본값 사용.

import asyncio
import json
import os
import re
import time
from pathlib import Path
import httpx

OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "gemma4:12b")

_DEFAULT_URL  = os.environ.get("OLLAMA_BASE_URL", "http://192.168.11.131:1234")
_SETTINGS_FILE = Path(__file__).parent.parent / "ollama_settings.json"

def _load_saved_url() -> str:
    try:
        data = json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
        return data.get("url") or _DEFAULT_URL
    except Exception:
        return _DEFAULT_URL

_current_url: str = _load_saved_url()


def get_ollama_url() -> str:
    return _current_url


def set_ollama_url(url: str) -> None:
    global _current_url
    _current_url = url
    _SETTINGS_FILE.write_text(json.dumps({"url": url}, ensure_ascii=False), encoding="utf-8")
    print(f"[Ollama] URL 변경됨: {url}")


async def check_ollama() -> bool:
    """Ollama 서버 연결 가능 여부 확인. 5초 내 응답 없으면 False."""
    try:
        async with httpx.AsyncClient(verify=False, timeout=5) as client:
            resp = await client.get(f"{get_ollama_url()}/api/tags")
            return resp.status_code == 200
    except Exception:
        return False


async def _call_ollama_once(system: str, prompt: str) -> str:
    """Ollama 단일 호출. 빈 응답 포함한 원시 결과 반환."""
    full = []
    has_thinking = False
    http_timeout = httpx.Timeout(connect=30.0, read=None, write=30.0, pool=30.0)
    async with httpx.AsyncClient(verify=False, timeout=http_timeout) as client:
        async with client.stream(
            "POST",
            f"{get_ollama_url()}/api/generate",
            json={
                "model": OLLAMA_MODEL,
                "system": system,
                "prompt": prompt,
                "stream": True,
                "options": {"num_ctx": 8192, "think": False},
            },
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line:
                    continue
                chunk = json.loads(line)
                if chunk.get("thinking"):
                    has_thinking = True
                token = chunk.get("response", "")
                print(token, end="", flush=True)
                full.append(token)
                if chunk.get("done"):
                    break
    if has_thinking and not full:
        print("\n[Ollama] 경고: thinking 토큰만 수신, response 없음")
    return "".join(full)


async def _log_progress(start: float) -> None:
    """60초마다 경과 시간 출력. call_ollama에서 백그라운드 태스크로 실행."""
    while True:
        await asyncio.sleep(60)
        elapsed = int(time.time() - start)
        print(f"\n[Ollama] {elapsed // 60}분 경과...", flush=True)


async def call_ollama(system: str, prompt: str, timeout: int = 600) -> str:
    """Ollama /api/generate 비동기 스트리밍 호출. 빈 응답 시 1회 재시도."""
    try:
        start = time.time()
        print("[Ollama] 생성 중... ", end="", flush=True)
        progress = asyncio.create_task(_log_progress(start))
        try:
            result = await asyncio.wait_for(_call_ollama_once(system, prompt), timeout=timeout)
        finally:
            progress.cancel()
            try:
                await progress
            except asyncio.CancelledError:
                pass
        elapsed = time.time() - start
        print(f"\n[Ollama] 완료 ({elapsed:.1f}초) | 응답 길이: {len(result)}자")

        if not result:
            print("[Ollama] 경고: 빈 응답 — 1회 재시도")
            result = await asyncio.wait_for(_call_ollama_once(system, prompt), timeout=timeout)
            elapsed2 = time.time() - start
            print(f"\n[Ollama] 재시도 완료 ({elapsed2:.1f}초) | 응답 길이: {len(result)}자")
            if not result:
                print("[Ollama] 경고: 재시도 후에도 빈 응답")

        return result
    except asyncio.CancelledError:
        print("\n[Ollama] 취소됨")
        raise
    except Exception as e:
        print(f"\n[Ollama] 호출 실패: {type(e).__name__}: {e}")
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
