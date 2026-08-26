# -*- coding: utf-8 -*-
# 보고서 자동 생성 설정 API 라우터. 관리자 페이지("자동화 관리")의 생성 탭이 사용한다.
#
# GET  /api/generation-settings?report_type=daily|weekly  : 저장된 설정 조회 (없으면 기본값 반환).
# POST /api/generation-settings                            : 설정 저장 + 그 즉시 스케줄 재등록
#   (서버 재시작 없이 다음 생성부터 바뀐 시각이 반영된다).
# DELETE /api/generation-settings?report_type=daily|weekly : 저장된 설정을 지우고 기본값으로
#   되돌린다(core/report_generation_settings.py의 DEFAULTS). 스케줄도 기본 생성 시각으로 즉시 재등록한다.
#
# 지금 생성(테스트)은 별도 엔드포인트 없음 — 기존 보고서 페이지의 "재생성" 버튼이 이미
# POST /api/report/daily(weekly)/generate를 그대로 호출하므로 그걸 재사용한다.
#
# 생성 이력도 별도 API 없음 — 기존 GET /api/audit/log를 daily_report_*/weekly_report_*
# 액션으로 프론트에서 필터링해서 그대로 쓴다.
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from core.report_generation_settings import (
    get_generation_settings, save_generation_settings, reset_generation_settings,
)
from features.admin.admin_endpoints import require_admin
from features.collection.scheduler import reschedule_generation_job

router = APIRouter()

_REPORT_TYPES = {"daily", "weekly"}


class GenerationSettingsBody(BaseModel):
    report_type: str
    enabled: bool
    generate_hour: int
    generate_minute: int


@router.get("/api/generation-settings")
def get_settings(report_type: str = Query(...), _: None = Depends(require_admin)):
    if report_type not in _REPORT_TYPES:
        raise HTTPException(status_code=400, detail="report_type은 daily 또는 weekly여야 합니다")
    return get_generation_settings(report_type)


@router.post("/api/generation-settings")
def update_settings(body: GenerationSettingsBody, _: None = Depends(require_admin)):
    if body.report_type not in _REPORT_TYPES:
        raise HTTPException(status_code=400, detail="report_type은 daily 또는 weekly여야 합니다")
    save_generation_settings(body.report_type, body.model_dump(exclude={"report_type"}))
    reschedule_generation_job(body.report_type)
    return get_generation_settings(body.report_type)


@router.delete("/api/generation-settings")
def reset_settings(report_type: str = Query(...), _: None = Depends(require_admin)):
    if report_type not in _REPORT_TYPES:
        raise HTTPException(status_code=400, detail="report_type은 daily 또는 weekly여야 합니다")
    reset_generation_settings(report_type)
    reschedule_generation_job(report_type)
    return get_generation_settings(report_type)
