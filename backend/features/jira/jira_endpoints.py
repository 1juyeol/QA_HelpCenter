# -*- coding: utf-8 -*-
# JIRA 미해결 버그 × CS 연관 분석 API 라우터.
# GET  /api/jira/bugs              : 미해결 서비스 이슈 목록 (CS 건수 내림차순). 캐시 TTL 60분, 만료 시 자동 동기화.
# GET  /api/jira/bugs/{key}/memos  : 특정 JIRA 이슈 키워드에 매칭된 CS 메모 전체 목록 (최신순).
# POST /api/jira/sync              : JIRA 즉시 재동기화 (캐시 강제 갱신). 관리자 전용.
from fastapi import APIRouter, Depends
from features.jira.jira_client import get_bugs, get_bug_memos, sync_bugs
from core.audit_log import log_action
from features.admin.admin_endpoints import require_admin

router = APIRouter()


@router.get("/api/jira/bugs")
def jira_bugs():
    return {"data": get_bugs()}


@router.get("/api/jira/bugs/{key}/memos")
def jira_bug_memos(key: str):
    return {"data": get_bug_memos(key)}


@router.post("/api/jira/sync")
def jira_sync(_: None = Depends(require_admin)):
    sync_bugs()
    log_action("jira_sync")
    return {"status": "ok"}
