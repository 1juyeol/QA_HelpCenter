# -*- coding: utf-8 -*-
# 인사이트 조회·갱신 API 라우터 (7개 엔드포인트). 집계는 insight_aggregations.py, 저장은 insights_cache.py에 위임한다.
# GET  /api/insights/wings_tickets            : 반복 Wings 티켓 캐시 조회 (parent_id·카테고리·상태
#                                               포함 — 버그 트래킹 화면과 가정별 이탈 위험 섹션이 같이 쓴다).
#                                               해결·미해결 전부 포함되며, 프론트(WingsTickets.tsx)가
#                                               상태로 필터링한다(기본은 미해결).
# GET  /api/insights/wings_summary            : "전체 티켓" 카드용 — 해결 포함 전체 건수·해결 건수 스냅샷.
# GET  /api/insights/repeat_parents           : 학부모 반복 인입 캐시 조회.
# GET  /api/insights/wings_delay_trend        : 7일+/30일+ 처리 지연 건수 일별 스냅샷(최근 100일).
#                                               과거 상태를 저장해둔 적이 없어 최초 배포 시점부터
#                                               쌓인다 — 프론트가 주 단위로 묶어서 추이 차트를 그린다.
# POST /api/insights/refresh/wings            : Wings 티켓 캐시만 즉시 재집계(Wings 상태 조회 포함). 관리자 전용.
# POST /api/insights/refresh/repeat_parents   : 학부모 반복 인입 캐시만 즉시 재집계. 관리자 전용.
#   두 갱신을 나눈 이유: 서로 무관한 집계라 자동 갱신 시각도 자동화 관리에서 각자 따로
#   설정한다(scheduler.py의 wings_refresh/repeat_parents_refresh) — 수동 새로고침도 그 경계를
#   그대로 따른다.
# GET  /api/insights/churn_reasons  : 해지·유지 상담 중 사유 필드가 있는 건을 사유별로 집계 (캐시 없이 즉시 계산).
# GET  /api/insights/device_swaps   : 기기 교체 요청을 기종·선출고 여부로 집계 (캐시 없이 즉시 계산).
# GET  /api/insights/retention      : 해지 방어 성공률·리텐션 오퍼별 집계 (캐시 없이 즉시 계산).
import json
from fastapi import APIRouter, Depends
from features.insights.insights_cache import _read_cache, get_wings_delay_trend
from features.collection.scheduler import update_wings_cache, update_repeat_parents_cache
from features.issues.churn_device_insights import get_churn_reason_stats, get_device_swap_stats
from features.issues.retention_insights import get_retention_stats
from features.admin.admin_endpoints import require_admin

router = APIRouter()


@router.get("/api/insights/wings_tickets")
def insights_wings_tickets():
    row = _read_cache("wings_tickets")
    if not row:
        return {"data": [], "updated_at": None}
    return {"data": json.loads(row["data"]), "updated_at": row["updated_at"]}


@router.get("/api/insights/wings_summary")
def insights_wings_summary():
    row = _read_cache("wings_summary")
    if not row:
        return {"total": 0, "resolved": 0, "updated_at": None}
    data = json.loads(row["data"])
    return {"total": data["total"], "resolved": data["resolved"], "updated_at": row["updated_at"]}


@router.get("/api/insights/repeat_parents")
def insights_repeat_parents():
    row = _read_cache("repeat_parents")
    if not row:
        return {"data": [], "updated_at": None}
    return {"data": json.loads(row["data"]), "updated_at": row["updated_at"]}


@router.get("/api/insights/wings_delay_trend")
def insights_wings_delay_trend():
    return {"data": get_wings_delay_trend()}


@router.post("/api/insights/refresh/wings")
async def insights_refresh_wings(_: None = Depends(require_admin)):
    await update_wings_cache()
    return {"status": "ok"}


@router.post("/api/insights/refresh/repeat_parents")
async def insights_refresh_repeat_parents(_: None = Depends(require_admin)):
    await update_repeat_parents_cache()
    return {"status": "ok"}


@router.get("/api/insights/churn_reasons")
def insights_churn_reasons():
    return get_churn_reason_stats()


@router.get("/api/insights/device_swaps")
def insights_device_swaps():
    return get_device_swap_stats()


@router.get("/api/insights/retention")
def insights_retention():
    return get_retention_stats()
