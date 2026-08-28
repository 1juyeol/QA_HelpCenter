# -*- coding: utf-8 -*-
# Gemma 프롬프트 편집 API 라우터. 관리자 페이지("자동화 관리")의 프롬프트 탭이 사용한다.
#
# GET  /api/prompt-settings/catalog         : 편집 가능한 프롬프트 전부 + 각 데이터 필드 사용 여부
#   (report_type로 필터 가능) — prompt_registry.py의 카탈로그를 그대로 반환.
# GET  /api/prompt-settings?prompt_key=     : 특정 프롬프트의 현재 텍스트(커스텀 있으면 그것,
#   없으면 기본값) + 커스텀 여부.
# POST /api/prompt-settings                 : 프롬프트 텍스트 저장 + 그 즉시 다음 Gemma 호출부터 반영
#   (서버 재시작 불필요 — get_prompt_text가 매 호출마다 DB를 조회한다). 감사 로그에 남는다.
# DELETE /api/prompt-settings?prompt_key=   : 커스텀 값을 지우고 기본값으로 되돌린다. 감사 로그에 남는다.
#
# prompt_key가 prompt_registry.PROMPT_REGISTRY에 없는 값이면 전부 400을 반환한다 — 존재하지
# 않는 프롬프트를 실수로 만들어 저장하는 걸 막기 위함.
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from core.prompt_settings import get_prompt_text, save_prompt_text, reset_prompt_text, is_prompt_customized
from features.report.prompt_registry import PROMPT_REGISTRY, get_prompt_meta
from features.admin.admin_endpoints import require_admin
from core.audit_log import log_action

router = APIRouter()


def _require_known_key(prompt_key: str) -> dict:
    meta = get_prompt_meta(prompt_key)
    if meta is None:
        valid = ", ".join(p["key"] for p in PROMPT_REGISTRY)
        raise HTTPException(status_code=400, detail=f"prompt_key는 {valid} 중 하나여야 합니다")
    return meta


class PromptSettingsBody(BaseModel):
    prompt_key: str
    prompt_text: str


@router.get("/api/prompt-settings/catalog")
def get_prompt_catalog(report_type: str | None = Query(default=None), _: None = Depends(require_admin)):
    items = PROMPT_REGISTRY if report_type is None else [p for p in PROMPT_REGISTRY if p["report_type"] == report_type]
    return [
        {
            "key": p["key"], "report_type": p["report_type"], "order": p["order"],
            "label": p["label"], "description": p["description"], "fields": p["fields"],
            "customized": is_prompt_customized(p["key"]),
        }
        for p in sorted(items, key=lambda p: (p["report_type"], p["order"]))
    ]


@router.get("/api/prompt-settings")
def get_prompt_settings(prompt_key: str = Query(...), _: None = Depends(require_admin)):
    meta = _require_known_key(prompt_key)
    return {
        "prompt_key": prompt_key,
        "prompt_text": get_prompt_text(prompt_key, meta["default_text"]),
        "default_text": meta["default_text"],
        "customized": is_prompt_customized(prompt_key),
    }


@router.post("/api/prompt-settings")
def update_prompt_settings(body: PromptSettingsBody, _: None = Depends(require_admin)):
    meta = _require_known_key(body.prompt_key)
    save_prompt_text(body.prompt_key, body.prompt_text)
    log_action("prompt_save", f"prompt_key={body.prompt_key}")
    return {
        "prompt_key": body.prompt_key,
        "prompt_text": get_prompt_text(body.prompt_key, meta["default_text"]),
        "default_text": meta["default_text"],
        "customized": True,
    }


@router.delete("/api/prompt-settings")
def delete_prompt_settings(prompt_key: str = Query(...), _: None = Depends(require_admin)):
    meta = _require_known_key(prompt_key)
    reset_prompt_text(prompt_key)
    log_action("prompt_reset", f"prompt_key={prompt_key}")
    return {
        "prompt_key": prompt_key,
        "prompt_text": meta["default_text"],
        "default_text": meta["default_text"],
        "customized": False,
    }
