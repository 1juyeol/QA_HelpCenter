# -*- coding: utf-8 -*-
# 이슈 상세 목록 API 라우터.
# GET /api/issues: 날짜·기간·카테고리·버킷 필터를 조합해 이슈 목록을 반환한다.
#   subs 파라미터(쉼표 구분)로 복수 소분류 IN 필터 지원.
#   limit/offset 페이지네이션 지원. parent_id=92(내부 계정)는 NULL로 마스킹하여 반환한다.
# GET /api/issues/subs: 날짜 범위 + 대분류 조건의 소분류 목록 반환 (모달 체크박스 초기화용).
# 대시보드에서 카테고리 드릴다운·메모 모달 클릭 시 이 엔드포인트들을 호출한다.
from datetime import date
from fastapi import APIRouter, Query
from core.db import get_conn
from core.date_bucket_utils import _buckets_where, _period_where

router = APIRouter()


@router.get("/api/issues/subs")
def get_issue_subs(
    category_main: str = Query(...),
    start_date: str = Query(...),
    end_date: str = Query(...),
):
    """날짜 범위 + 대분류 내 소분류 목록 반환. 메모 모달 체크박스 초기화에 사용."""
    col = "date(datetime(created_date, '+9 hours'))"
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT new_category_sub, COUNT(*) AS cnt FROM cs_issues "
            f"WHERE {col} BETWEEN ? AND ? AND new_category_main = ? AND new_category_sub IS NOT NULL "
            f"GROUP BY new_category_sub ORDER BY cnt DESC",
            [start_date, end_date, category_main],
        ).fetchall()
    return {"subs": [r[0] for r in rows if r[0]]}


@router.get("/api/issues")
def list_issues(
    category_main: str = Query(default=None),
    category_sub: str = Query(default=None),
    subs: str = Query(default=None),
    target_date: str = Query(default=None),
    period: str = "day",
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
    unclassified: bool = False,
    limit: int = 200,
    offset: int = 0,
    bucket: str = Query(default=None),
    q: str = Query(default=None),
):
    if start_date and end_date:
        col = "date(datetime(created_date, '+9 hours'))"
        where, params = f"{col} BETWEEN ? AND ?", [start_date, end_date]
    else:
        if not target_date:
            target_date = str(date.today())
        where, params = _period_where(target_date, period)
    if bucket:
        buckets_list = [b.strip() for b in bucket.split(',') if b.strip()]
        if buckets_list:
            bw, bp = _buckets_where(buckets_list)
            where += f" AND {bw}"
            params.extend(bp)
    if q:
        where += " AND (call_memo LIKE ? OR student_id LIKE ? OR CAST(parent_id AS TEXT) LIKE ?)"
        like = f"%{q}%"
        params.extend([like, like, like])
    if unclassified:
        where += " AND new_category_main IS NULL"
    elif category_main:
        where += " AND new_category_main = ?"
        params.append(category_main)
        if subs:
            sub_list = [s for s in subs.split(',') if s]
            if sub_list:
                placeholders = ','.join('?' * len(sub_list))
                where += f" AND new_category_sub IN ({placeholders})"
                params.extend(sub_list)
        elif category_sub:
            where += " AND new_category_sub = ?"
            params.append(category_sub)
    with get_conn() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM cs_issues WHERE {where}", params).fetchone()[0]
        rows = conn.execute(
            f"""
            SELECT id, datetime(created_date, '+9 hours') AS created_date,
                   new_category_main, new_category_sub, call_memo,
                   student_id, CASE WHEN parent_id = 92 THEN NULL ELSE parent_id END AS parent_id
            FROM cs_issues WHERE {where}
            ORDER BY created_date DESC LIMIT ? OFFSET ?
            """,
            params + [limit, offset],
        ).fetchall()
    return {"total": total, "items": [dict(r) for r in rows]}
