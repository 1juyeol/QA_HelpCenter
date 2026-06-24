# -*- coding: utf-8 -*-
# Gemma 서버 설정 API. 일별·주간 보고서 등 Gemma를 쓰는 모든 기능이 이 설정을 공유한다.
# GET  /api/settings/gemma  : 현재 URL + 프리셋 목록 반환
# POST /api/settings/gemma  : URL 변경 (메모리 즉시 반영 + gemma_settings.json 저장)
#
# 프리셋은 이 파일의 GEMMA_PRESETS 상수에서 관리한다.
# 저장된 값은 서버 재시작 시에도 유지된다 (gemma_settings.json).

from fastapi import APIRouter
from pydantic import BaseModel
from core.gemma_client import get_gemma_url, set_gemma_url

router = APIRouter()

GEMMA_PRESETS = [
    "http://192.168.11.131:1234",
    "http://192.168.10.221:4521",
]


class GemmaUrlBody(BaseModel):
    url: str


@router.get("/api/settings/gemma")
def get_gemma_settings():
    return {"url": get_gemma_url(), "presets": GEMMA_PRESETS}


@router.post("/api/settings/gemma")
def update_gemma_settings(body: GemmaUrlBody):
    set_gemma_url(body.url)
    return {"url": get_gemma_url()}
