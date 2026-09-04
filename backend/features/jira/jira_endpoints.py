# -*- coding: utf-8 -*-
# JIRA 미해결 버그 조회 API 라우터.
# GET  /api/jira/bugs      : 미해결 서비스 이슈 목록 (생성일 오름차순). 캐시(jira_issues) 조회만
#                             한다 — 동기화는 scheduler.py의 jira_refresh 잡이 백그라운드에서 담당.
# GET  /api/jira/trend     : 전체/검토 대기/6개월+/1년+ 방치 건수 일별 스냅샷(최근 100일).
# GET  /api/jira/resolved  : 최근 7일 내 해결된 이슈 목록 (해결일 내림차순). 캐시(jira_resolved_issues)
#                             조회만 한다 — jira_refresh 잡이 같이 갱신한다.
# POST /api/jira/sync      : JIRA 즉시 재동기화 + 스냅샷 기록 (캐시 강제 갱신). 관리자 전용.
from fastapi import APIRouter, Depends
from features.jira.jira_client import get_bugs, get_jira_trend, get_resolved_bugs
from features.admin.admin_endpoints import require_admin

router = APIRouter()


@router.get("/api/jira/bugs")
def jira_bugs():
    return {"data": get_bugs()}


@router.get("/api/jira/trend")
def jira_trend():
    return {"data": get_jira_trend()}


@router.get("/api/jira/resolved")
def jira_resolved():
    return {"data": get_resolved_bugs()}


@router.post("/api/jira/sync")
async def jira_sync(_: None = Depends(require_admin)):
    from features.collection.scheduler import update_jira_cache
    await update_jira_cache()
    return {"status": "ok"}
