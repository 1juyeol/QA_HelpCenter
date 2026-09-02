# -*- coding: utf-8 -*-
# 수집 이력·on/off 제어 API 라우터 (7개 엔드포인트).
# GET  /api/collection/latest      : collection_log 테이블에서 가장 최근 수집 기록 1건을 반환한다.
#   헤더에 표시되는 "마지막 수집: HH:MM" 텍스트의 데이터 소스이며, App.tsx에서 60초마다 폴링한다.
# GET  /api/collection/status      : 현재 CS 상담 수집 API 호출 on/off 상태 조회 (누구나 조회 가능).
# GET  /api/collection/daily_counts: 최근 N일간 날짜별 실제 호출 횟수. collection_log는 실제로
#   API를 호출했을 때만(get_collection_enabled()가 True일 때만) 기록이 남으므로, 이 값을 세면
#   승인된 호출 빈도(하루 최대 146회)를 지키고 있는지 그대로 확인할 수 있다. 관리자 페이지의
#   "인사이트 로드맵"에서 표로 보여준다.
# GET  /api/collection/log         : 오늘(KST) 호출 로그(호출별 상세)를 그대로 나열한다.
#   date(collected_at) = date('now', 'localtime')로 KST 기준 "오늘"만 정확히 걸러낸다 —
#   'localtime'을 안 붙이면 SQLite가 UTC 기준으로 날짜를 계산해서 자정 근처에 날짜가 어긋난다.
# GET  /api/collection/log/over-limit : 하루 최대 _DAILY_CALL_LIMIT회를 초과한 날의 호출만 모아서 보여준다.
# GET  /api/collection/log/{log_id}/issues : 그 호출에서 정확히 어떤 이슈를 가져왔는지 복원한다.
#   collection_log.last_id(그 호출 시작 시점 커서)와 count_fetched를 이용해
#   issues WHERE id > last_id ORDER BY id LIMIT count_fetched 로 조회 — 근사치가 아니라 정확한 목록.
# POST /api/collection/enabled     : on/off 전환. 실제 API 호출을 시작/중단시키는 조작이라
#   관리자 인증(require_admin)이 필요하다. 서버 재시작 없이 바로 다음 스케줄 트리거부터 반영된다
#   (features/collection/scheduler.py가 매번 get_collection_enabled()를 확인하는 구조).
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from core.db import get_conn
from core.pii_mask import mask_phone_numbers
from core.collection_settings import get_collection_enabled, set_collection_enabled
from core.audit_log import log_action
from features.admin.admin_endpoints import require_admin

router = APIRouter()

# 승인된 하루 최대 호출 횟수. frontend/src/pages/admin/ApiConsole.tsx의 DAILY_CALL_LIMIT와
# 반드시 같이 유지해야 한다 (감사·모니터링 표시용 상수라 서버·프론트 양쪽에 따로 정의됨).
_DAILY_CALL_LIMIT = 146


@router.get("/api/collection/latest")
def collection_latest():
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM collection_log ORDER BY id DESC LIMIT 1"
        ).fetchone()
    return dict(row) if row else {}


@router.get("/api/collection/daily_counts")
def collection_daily_counts(days: int = Query(default=7, ge=1, le=90)):
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT date(collected_at) AS day, COUNT(*) AS count
            FROM collection_log
            WHERE date(collected_at) >= date('now', ?)
            GROUP BY day ORDER BY day DESC
            """,
            (f"-{days} days",),
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/api/collection/log")
def collection_log_list():
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, collected_at, count_fetched, status, message, last_id, end_id, source
            FROM collection_log
            WHERE date(collected_at) = date('now', 'localtime')
            ORDER BY id DESC
            """
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/api/collection/log/over-limit")
def collection_log_over_limit():
    """하루 호출 횟수가 승인된 한도(_DAILY_CALL_LIMIT)를 넘긴 날짜의 호출만 모아서 반환한다.
    collection_log는 실제 호출마다 이미 다 기록되므로, 별도 테이블 없이 그 날짜만 골라 조회한다."""
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, collected_at, count_fetched, status, message, last_id, end_id, source
            FROM collection_log
            WHERE date(collected_at) IN (
                SELECT date(collected_at) FROM collection_log
                GROUP BY date(collected_at) HAVING COUNT(*) > ?
            )
            ORDER BY id DESC
            """,
            (_DAILY_CALL_LIMIT,),
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/api/collection/log/{log_id}/issues")
def collection_log_issues(log_id: int):
    with get_conn() as conn:
        log = conn.execute(
            "SELECT count_fetched, last_id FROM collection_log WHERE id = ?", (log_id,)
        ).fetchone()
        if log is None:
            raise HTTPException(status_code=404, detail="수집 로그를 찾을 수 없습니다")
        if not log["count_fetched"] or log["last_id"] is None:
            return {"items": []}
        rows = conn.execute(
            """
            SELECT id, datetime(created_date, '+9 hours') AS created_date,
                   new_category_main, new_category_sub, call_memo,
                   student_id, CASE WHEN parent_id = 92 THEN NULL ELSE parent_id END AS parent_id
            FROM issues WHERE id > ? ORDER BY id LIMIT ?
            """,
            (log["last_id"], log["count_fetched"]),
        ).fetchall()
    items = [dict(r) for r in rows]
    for item in items:
        item["call_memo"] = mask_phone_numbers(item["call_memo"])
    return {"items": items}


@router.get("/api/collection/status")
def collection_status():
    return {"enabled": get_collection_enabled()}


class CollectionEnabledBody(BaseModel):
    enabled: bool


@router.post("/api/collection/enabled")
def update_collection_status(body: CollectionEnabledBody, _: None = Depends(require_admin)):
    set_collection_enabled(body.enabled)
    log_action("collection_toggle", f"enabled={body.enabled}")
    return {"enabled": get_collection_enabled()}
