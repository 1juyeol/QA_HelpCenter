# -*- coding: utf-8 -*-
# Ollama 서버 설정 API. 일별·주간 보고서 등 Ollama를 쓰는 모든 기능이 이 설정을 공유한다.
# GET  /api/settings/ollama  : 현재 URL + 프리셋 목록 반환
# POST /api/settings/ollama  : URL 변경 (메모리 즉시 반영 + ollama_settings.json 저장)
#
# 프리셋은 이 파일의 OLLAMA_PRESETS 상수에서 관리한다.
# 저장된 값은 서버 재시작 시에도 유지된다 (ollama_settings.json).

from fastapi import APIRouter
from pydantic import BaseModel
from core.ollama_client import get_ollama_url, set_ollama_url

router = APIRouter()

OLLAMA_PRESETS = [
    "http://192.168.11.131:1234",
    "http://192.168.10.221:4521",
]


class OllamaUrlBody(BaseModel):
    url: str


@router.get("/api/settings/ollama")
def get_ollama_settings():
    return {"url": get_ollama_url(), "presets": OLLAMA_PRESETS}


@router.post("/api/settings/ollama")
def update_ollama_settings(body: OllamaUrlBody):
    set_ollama_url(body.url)
    return {"url": get_ollama_url()}
