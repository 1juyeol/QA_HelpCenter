# 인사이트 집계 결과의 DB 캐시 관리. 집계 쿼리가 무거우므로 결과를 insights_cache 테이블에 보관한다.
# _save_insights_cache : wings_tickets·repeat_parents를 JSON 직렬화 후 INSERT OR REPLACE.
# _read_cache          : 키로 캐시 단일 행 조회. 없으면 None 반환.
# _init_insights_cache : 서버 시작 시 캐시가 비어 있을 때만 최초 집계를 실행한다 (이미 있으면 스킵).
# 캐시 갱신 시점: 서버 시작 시(초기화) / POST /api/insights/refresh(수동) / 매일 자정(scheduler.py 자동).
import json
from datetime import date, timedelta
from core.db import get_conn
from features.insights.insight_aggregations import compute_wings_tickets, compute_repeat_parents


def _save_insights_cache(wings, parents):
    from datetime import datetime
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with get_conn() as conn:
        conn.execute("INSERT OR REPLACE INTO insights_cache VALUES (?, ?, ?)",
                     ("wings_tickets", json.dumps(wings, ensure_ascii=False), now))
        conn.execute("INSERT OR REPLACE INTO insights_cache VALUES (?, ?, ?)",
                     ("repeat_parents", json.dumps(parents, ensure_ascii=False), now))
        conn.commit()


def _read_cache(key):
    with get_conn() as conn:
        row = conn.execute("SELECT data, updated_at FROM insights_cache WHERE key=?", (key,)).fetchone()
    return row


async def _init_insights_cache():
    with get_conn() as conn:
        has_cache = conn.execute("SELECT 1 FROM insights_cache LIMIT 1").fetchone()
    if not has_cache:
        end = str(date.today())
        start = str(date.today() - timedelta(days=30))
        _save_insights_cache(compute_wings_tickets(start, end), compute_repeat_parents(start, end))
