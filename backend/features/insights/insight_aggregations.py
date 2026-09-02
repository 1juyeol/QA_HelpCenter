# -*- coding: utf-8 -*-
# 인사이트 집계 순수 계산 함수. DB를 직접 조회해 집계 결과를 반환하며, 저장은 insights_cache.py가 담당한다.
# compute_wings_tickets : call_memo에서 Wings 티켓 URL을 정규식으로 추출해 동일 티켓 ID에 연결된 CS 건을
#   집계한다. 언급이 1건뿐인 티켓도 포함한다("전체 티켓" 집계에 필요) — 호출부(scheduler.py)가 Wings
#   상태를 조회해 해결/취소/merged를 걸러내는 건 이후 단계다. Wings 티켓은 1건=1가정 전용 A/S
#   케이스라(여러 고객이 같은 티켓을 공유하지 않음), cs_count가 큰 건 "여러 고객에게 퍼진 버그"가
#   아니라 "그 가정 하나가 CS를 여러 번 거쳤는데도 안 풀린 것" — 미해결 버그 트래킹(개발팀 압박)과
#   가정별 이탈 위험 파악 양쪽에 다 쓰여서, parent_id·카테고리(new_category_main)도 같이 뽑는다.
# compute_repeat_parents: parent_id 기준 30일 내 3회 이상 인입한 학부모를 집계한다.
#   parent_id <= 100000은 내부 테스트 계정이므로 제외한다.
import re
from collections import defaultdict
from core.db import get_conn
from core.pii_mask import mask_phone_numbers

WINGS_TICKET_RE = re.compile(r'wings\.danbiedu\.co\.kr/#ticket/zoom/(\d+)')


def group_wings_tickets(rows: list, limit: int = 50) -> list:
    """compute_wings_tickets()의 순수 집계 부분. rows는 kst_date·call_memo·student_id·parent_id·
    new_category_main 키를 가진 행(dict 또는 sqlite3.Row) 목록 — DB 조회와 분리해서 이 부분만
    단위 테스트한다. 같은 티켓에 여러 memo가 있어도 student_id·parent_id·카테고리는 첫 번째로
    발견되는 값 하나만 쓴다(같은 가정 케이스라 값이 갈릴 이유가 없다 — null인 행이 섞여 있을
    때만 대비). parent_id <= 100000은 내부 테스트 계정(compute_repeat_parents와 동일 기준)이라
    채택하지 않는다 — student_id는 이 기준을 쓰는 곳이 따로 없어(운영현황 표와 동일하게) 값이
    있으면 그대로 채택한다. 언급이 1건뿐인 티켓도 결과에 포함한다 — "여러번 인입"(cs_count > 1)
    여부는 호출부가 필요에 따라 걸러 쓴다."""
    counts = defaultdict(lambda: {
        "cs_count": 0, "latest_date": None, "first_date": None, "memos": [],
        "student_id": None, "parent_id": None, "category": None,
    })
    for r in rows:
        for ticket_id in WINGS_TICKET_RE.findall(r["call_memo"] or ""):
            entry = counts[ticket_id]
            entry["cs_count"] += 1
            if entry["latest_date"] is None:
                entry["latest_date"] = r["kst_date"]
            entry["first_date"] = r["kst_date"]
            entry["memos"].append({"date": r["kst_date"], "memo": mask_phone_numbers(r["call_memo"])})
            if entry["student_id"] is None and r["student_id"]:
                entry["student_id"] = r["student_id"]
            if entry["parent_id"] is None and r["parent_id"] is not None and r["parent_id"] > 100000:
                entry["parent_id"] = r["parent_id"]
            if entry["category"] is None and r["new_category_main"]:
                entry["category"] = r["new_category_main"]

    result = [
        {"ticket_id": tid, "cs_count": info["cs_count"], "latest_date": info["latest_date"],
         "first_date": info["first_date"], "memos": info["memos"], "student_id": info["student_id"],
         "parent_id": info["parent_id"], "category": info["category"]}
        for tid, info in counts.items()
    ]
    result.sort(key=lambda x: -x["cs_count"])
    return result[:limit]


def compute_wings_tickets(start_date: str, end_date: str, limit: int = 50) -> list:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT datetime(created_date, '+9 hours') AS kst_date, call_memo, student_id, parent_id, new_category_main
            FROM issues
            WHERE date(datetime(created_date, '+9 hours')) BETWEEN ? AND ?
              AND call_memo LIKE '%wings.danbiedu.co.kr/#ticket/zoom/%'
            ORDER BY kst_date DESC
            """,
            (start_date, end_date),
        ).fetchall()
    return group_wings_tickets(rows, limit)


def compute_repeat_parents(start_date: str, end_date: str, limit: int = 100) -> list:
    col = "date(datetime(created_date, '+9 hours'))"
    with get_conn() as conn:
        repeat_ids = {
            r["parent_id"]: r["cnt"]
            for r in conn.execute(
                f"""
                SELECT parent_id, COUNT(*) AS cnt
                FROM cs_issues
                WHERE {col} BETWEEN ? AND ?
                  AND parent_id > 100000
                GROUP BY parent_id HAVING cnt >= 3
                ORDER BY cnt DESC LIMIT ?
                """,
                (start_date, end_date, limit),
            ).fetchall()
        }
        if not repeat_ids:
            return []

        placeholders = ",".join("?" * len(repeat_ids))
        rows = conn.execute(
            f"""
            SELECT parent_id,
                   datetime(created_date, '+9 hours') AS kst_date,
                   call_memo, new_category_main, new_category_sub
            FROM cs_issues
            WHERE {col} BETWEEN ? AND ?
              AND parent_id > 100000
              AND parent_id IN ({placeholders})
            ORDER BY parent_id, kst_date DESC
            """,
            (start_date, end_date, *repeat_ids.keys()),
        ).fetchall()

    grouped = defaultdict(lambda: {"cs_count": 0, "latest_date": None, "memos": [], "categories": set()})
    for r in rows:
        entry = grouped[r["parent_id"]]
        entry["cs_count"] += 1
        if entry["latest_date"] is None:
            entry["latest_date"] = r["kst_date"]
        cat = " > ".join(filter(None, [r["new_category_main"], r["new_category_sub"]]))
        entry["memos"].append({"date": r["kst_date"], "memo": mask_phone_numbers(r["call_memo"]), "category": cat})
        if r["new_category_main"]:
            entry["categories"].add(r["new_category_main"])

    result = [
        {"parent_id": pid, "cs_count": info["cs_count"], "latest_date": info["latest_date"],
         "memos": info["memos"], "categories": list(info["categories"])}
        for pid, info in grouped.items()
    ]
    result.sort(key=lambda x: -x["cs_count"])
    return result
