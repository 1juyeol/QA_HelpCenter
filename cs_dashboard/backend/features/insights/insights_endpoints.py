# 인사이트 조회·갱신 API 라우터 (5개 엔드포인트). 집계는 insight_aggregations.py, 저장은 insights_cache.py에 위임한다.
# GET  /api/insights/wings_tickets  : 반복 Wings 티켓 캐시 조회.
# GET  /api/insights/repeat_parents : 학부모 반복 인입 캐시 조회.
# POST /api/insights/refresh        : 즉시 재집계 후 캐시 갱신 — scheduler.py의 update_insights_cache()를 호출해
#                                     Wings 상태 enrichment까지 포함한다.
# GET  /api/insights/churn_reasons  : 해지·유지 상담 중 사유 필드가 있는 건을 사유별로 집계 (캐시 없이 즉시 계산).
# GET  /api/insights/device_swaps   : 기기 교체 요청을 기종·선출고 여부로 집계 (캐시 없이 즉시 계산).
# GET  /api/insights/retention      : 해지 방어 성공률·리텐션 오퍼별 집계 (캐시 없이 즉시 계산).
import json
from fastapi import APIRouter
from features.insights.insights_cache import _read_cache
from features.collection.scheduler import update_insights_cache
from features.issues.churn_device_insights import get_churn_reason_stats, get_device_swap_stats
from features.issues.retention_insights import get_retention_stats

router = APIRouter()


@router.get("/api/insights/wings_tickets")
def insights_wings_tickets():
    row = _read_cache("wings_tickets")
    if not row:
        return {"data": [], "updated_at": None}
    return {"data": json.loads(row["data"]), "updated_at": row["updated_at"]}


@router.get("/api/insights/repeat_parents")
def insights_repeat_parents():
    row = _read_cache("repeat_parents")
    if not row:
        return {"data": [], "updated_at": None}
    return {"data": json.loads(row["data"]), "updated_at": row["updated_at"]}


@router.post("/api/insights/refresh")
async def insights_refresh():
    await update_insights_cache()
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
