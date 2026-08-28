# -*- coding: utf-8 -*-
# 자동 실행(생성·갱신) on/off + 시각 설정 API 라우터. 관리자 페이지("자동화 관리")가 사용한다.
# report_type은 daily/weekly(보고서 자동 생성) 뿐 아니라 wings_refresh/repeat_parents_refresh
# (인사이트 캐시 자동 갱신)까지 포함한다 — 전부 on/off + 시각이라는 같은 설정 형태라 이름은
# "보고서 생성" 전용이지만 그대로 재사용한다.
#
# GET  /api/generation-settings?report_type=...  : 저장된 설정 조회 (없으면 기본값 반환).
# POST /api/generation-settings                   : 설정 저장 + 그 즉시 스케줄 재등록
#   (서버 재시작 없이 다음 실행부터 바뀐 시각이 반영된다).
# DELETE /api/generation-settings?report_type=... : 저장된 설정을 지우고 기본값으로
#   되돌린다(core/report_generation_settings.py의 DEFAULTS). 스케줄도 기본 시각으로 즉시 재등록한다.
#
# 지금 생성/갱신(테스트)은 별도 엔드포인트 없음 — 보고서 페이지의 "재생성" 버튼(POST
# /api/report/daily(weekly)/generate), 인사이트 페이지의 "새로고침" 버튼(POST
# /api/insights/refresh/wings, /api/insights/refresh/repeat_parents)을 그대로 재사용한다.
#
# 이력도 별도 API 없음 — 기존 GET /api/audit/log를 daily_report_*/weekly_report_*/
# wings_cache_refresh*/repeat_parents_cache_refresh* 액션(실행 결과)과 generation_settings_save/
# generation_settings_reset 액션(설정 변경 자체)으로 프론트에서 필터링해서 그대로 쓴다.
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from core.report_generation_settings import (
    get_generation_settings, save_generation_settings, reset_generation_settings,
)
from features.admin.admin_endpoints import require_admin
from features.collection.scheduler import reschedule_generation_job
from core.audit_log import log_action

router = APIRouter()

# daily/weekly는 보고서 자동 생성, wings_refresh/repeat_parents_refresh는 인사이트 캐시
# 자동 갱신이다 — 이름은 "보고서 생성" 전용이지만 on/off + 시각이라는 설정 형태가 같아서
# 같은 테이블·엔드포인트를 그대로 재사용한다(scheduler.py의 _GENERATION_JOB_* 참고).
_REPORT_TYPES = {"daily", "weekly", "wings_refresh", "repeat_parents_refresh"}


class GenerationSettingsBody(BaseModel):
    report_type: str
    enabled: bool
    generate_hour: int
    generate_minute: int


@router.get("/api/generation-settings")
def get_settings(report_type: str = Query(...), _: None = Depends(require_admin)):
    if report_type not in _REPORT_TYPES:
        raise HTTPException(status_code=400, detail=f"report_type은 {', '.join(sorted(_REPORT_TYPES))} 중 하나여야 합니다")
    return get_generation_settings(report_type)


@router.post("/api/generation-settings")
def update_settings(body: GenerationSettingsBody, _: None = Depends(require_admin)):
    if body.report_type not in _REPORT_TYPES:
        raise HTTPException(status_code=400, detail=f"report_type은 {', '.join(sorted(_REPORT_TYPES))} 중 하나여야 합니다")
    save_generation_settings(body.report_type, body.model_dump(exclude={"report_type"}))
    reschedule_generation_job(body.report_type)
    log_action("generation_settings_save", f"report_type={body.report_type}, enabled={body.enabled}, hour={body.generate_hour}, minute={body.generate_minute}")
    return get_generation_settings(body.report_type)


@router.delete("/api/generation-settings")
def reset_settings(report_type: str = Query(...), _: None = Depends(require_admin)):
    if report_type not in _REPORT_TYPES:
        raise HTTPException(status_code=400, detail=f"report_type은 {', '.join(sorted(_REPORT_TYPES))} 중 하나여야 합니다")
    reset_generation_settings(report_type)
    reschedule_generation_job(report_type)
    log_action("generation_settings_reset", f"report_type={report_type}")
    return get_generation_settings(report_type)
