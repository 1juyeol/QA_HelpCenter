# -*- coding: utf-8 -*-
# 감사 로그 조회 API.
# GET /api/audit/log?limit=200 : 관리자 제어 액션·보고서 생성 이력을 최신순으로 반환한다.
#   관리자만 봐야 할 시스템 조작 이력이라 require_admin으로 보호한다 (다른 관리자 페이지
#   데이터와 달리, 이건 "누가 무엇을 언제 바꿨는지"를 보여주는 민감한 메타데이터이기 때문).
from fastapi import APIRouter, Depends, Query
from core.audit_log import list_audit_log
from features.admin.admin_endpoints import require_admin

router = APIRouter()


@router.get("/api/audit/log")
def audit_log_list(
    limit: int = Query(default=200, ge=1, le=1000),
    _: None = Depends(require_admin),
):
    return list_audit_log(limit)
