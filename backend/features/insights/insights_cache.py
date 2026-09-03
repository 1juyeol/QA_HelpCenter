# -*- coding: utf-8 -*-
# 인사이트 집계 결과의 DB 캐시 관리. 집계 쿼리가 무거우므로 결과를 insights_cache 테이블에 보관한다.
# _save_wings_cache          : wings_tickets·wings_summary를 JSON 직렬화 후 INSERT OR REPLACE.
#   wings_summary = {"total": 전체 티켓 수(해결 포함), "resolved": 그중 해결 건수} — "전체 티켓" 카드용.
# _save_repeat_parents_cache : repeat_parents를 JSON 직렬화 후 INSERT OR REPLACE.
#   두 저장 함수를 나눈 이유: Wings 티켓과 학부모 반복 인입은 서로 무관한 집계라 각자 다른
#   시각에 독립적으로 자동 갱신할 수 있어야 한다(scheduler.py의 wings_refresh/repeat_parents_refresh
#   가 각각 자동화 관리에서 설정한 시각에 따로 실행된다) — 한쪽을 갱신한다고 다른 쪽 캐시까지
#   같이 덮어쓸 이유가 없다.
# _read_cache          : 키로 캐시 단일 행 조회. 없으면 None 반환.
# _init_insights_cache : 서버 시작 시 캐시가 비어 있을 때만 최초 집계를 실행한다 (이미 있으면 스킵).
#   Wings 상태 조회 없이 채우는 임시값이라 wings_summary.resolved는 0으로 둔다 — 첫 자동/수동
#   갱신 때 정확한 값으로 바로 교체된다.
# _save_wings_delay_snapshot : 오늘 날짜 기준 7일+/30일+ 지연 건수를 하루 1건(INSERT OR REPLACE)
#   기록한다. 과거 상태를 저장해둔 적이 없어 주간 추이 차트는 이 시점부터 새로 쌓인다.
# get_wings_delay_trend : 최근 N일치 스냅샷을 날짜 오름차순으로 반환 (주 단위 묶기는 프론트에서).
import json
from datetime import date, timedelta
from core.db import get_conn
from features.insights.insight_aggregations import compute_wings_tickets, compute_repeat_parents


def _save_wings_cache(wings, summary):
    from datetime import datetime
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with get_conn() as conn:
        conn.execute("INSERT OR REPLACE INTO insights_cache VALUES (?, ?, ?)",
                     ("wings_tickets", json.dumps(wings, ensure_ascii=False), now))
        conn.execute("INSERT OR REPLACE INTO insights_cache VALUES (?, ?, ?)",
                     ("wings_summary", json.dumps(summary, ensure_ascii=False), now))
        conn.commit()


def _save_repeat_parents_cache(parents):
    from datetime import datetime
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with get_conn() as conn:
        conn.execute("INSERT OR REPLACE INTO insights_cache VALUES (?, ?, ?)",
                     ("repeat_parents", json.dumps(parents, ensure_ascii=False), now))
        conn.commit()


def _read_cache(key):
    with get_conn() as conn:
        row = conn.execute("SELECT data, updated_at FROM insights_cache WHERE key=?", (key,)).fetchone()
    return row


def _save_wings_delay_snapshot(snapshot_date: str, delayed_7_count: int, delayed_30_count: int):
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO wings_delay_snapshots VALUES (?, ?, ?)",
            (snapshot_date, delayed_7_count, delayed_30_count),
        )
        conn.commit()


def get_wings_delay_trend(days: int = 100) -> list:
    start = str(date.today() - timedelta(days=days))
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT snapshot_date, delayed_7_count, delayed_30_count FROM wings_delay_snapshots "
            "WHERE snapshot_date >= ? ORDER BY snapshot_date ASC",
            (start,),
        ).fetchall()
    return [dict(r) for r in rows]


async def _init_insights_cache():
    with get_conn() as conn:
        has_cache = conn.execute("SELECT 1 FROM insights_cache LIMIT 1").fetchone()
    if not has_cache:
        end = str(date.today())
        start = str(date.today() - timedelta(days=180))
        wings = compute_wings_tickets(start, end)
        _save_wings_cache(wings, {"total": len(wings), "resolved": 0})
        _save_repeat_parents_cache(compute_repeat_parents(start, end))
