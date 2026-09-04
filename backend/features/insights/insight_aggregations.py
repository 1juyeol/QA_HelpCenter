# -*- coding: utf-8 -*-
# 인사이트 집계 순수 계산 함수. DB를 직접 조회해 집계 결과를 반환하며, 저장은 insights_cache.py가 담당한다.
# compute_wings_tickets : call_memo에서 Wings 티켓 URL을 정규식으로 추출해 동일 티켓 ID에 연결된 CS 건을
#   집계한다. 언급이 1건뿐인 티켓도 포함한다("전체 티켓" 집계에 필요) — 호출부(scheduler.py)가 Wings
#   상태를 조회해 해결/취소/merged를 걸러내는 건 이후 단계다. Wings 티켓은 1건=1가정 전용 A/S
#   케이스라(여러 고객이 같은 티켓을 공유하지 않음), cs_count가 큰 건 "여러 고객에게 퍼진 버그"가
#   아니라 "그 가정 하나가 CS를 여러 번 거쳤는데도 안 풀린 것" — 미해결 버그 트래킹(개발팀 압박)과
#   가정별 이탈 위험 파악 양쪽에 다 쓰여서, parent_id·카테고리(new_category_main)도 같이 뽑는다.
# compute_repeat_parents: parent_id 기준 start_date~end_date 사이 3회 이상 인입한 학부모를
#   집계한다(호출부인 scheduler.py/insights_cache.py는 180일을 넘긴다 — 프론트(RepeatParents.tsx)가
#   그중 마지막 상담이 3개월 이내인 것만 화면에 남긴다). parent_id <= 100000은 내부 테스트
#   계정이므로 제외한다.
# compute_wings_delay_counts: group_wings_tickets() 결과(상태 포함)에서 "7일 이상 처리 지연"·
#   "30일 이상 처리 지연" 건수를 센다. WingsTickets.tsx의 isDelayedTicket/isLongUnresolvedTicket과
#   동일한 기준(첫 CS 언급일 기준 경과일, 해결/요청취소/merged 제외)이라 카드 숫자와 항상 일치한다.
#   scheduler.py가 매 갱신 때 이 값을 wings_delay_snapshots에 하루 1건씩 기록해 주간 추이를 쌓는다.
# compute_repeat_parents_snapshot_counts: compute_repeat_parents() 결과에서 최근 90일보다
#   오래된 메모를 걸러낸 뒤 RepeatParents.tsx의 KPI 카드 4종(반복 상담 학부모/동일 유형 연속
#   상담/7일 이내 재상담/복합 이슈 상담)과 동일한 기준으로 센다. 그 페이지의
#   getQualifyingMemos/hasConsecutiveRepeat/hasRecentShortGap/isComplexIssue와 반드시 같은
#   기준으로 유지해야 한다 — 어긋나면 주간보고서 스냅샷과 인사이트 페이지 숫자가 서로 달라진다.
import re
from collections import defaultdict
from datetime import date, datetime, timedelta
from core.db import get_conn
from core.pii_mask import mask_phone_numbers

WINGS_TICKET_RE = re.compile(r'wings\.danbiedu\.co\.kr/#ticket/zoom/(\d+)')


def group_wings_tickets(rows: list, limit: int | None = None) -> list:
    """compute_wings_tickets()의 순수 집계 부분. rows는 kst_date·call_memo·student_id·parent_id·
    new_category_main 키를 가진 행(dict 또는 sqlite3.Row) 목록 — DB 조회와 분리해서 이 부분만
    단위 테스트한다. rows는 호출부(compute_wings_tickets)에서 kst_date 내림차순(최신 먼저)으로
    들어온다. student_id·parent_id는 첫 번째로 발견되는(=가장 최근) 값을 쓴다(같은 가정 케이스라
    값이 갈릴 이유가 없다 — null인 행이 섞여 있을 때만 대비). category는 반대로 가장 오래된
    (최초 인입) 값을 쓴다 — 처음 접수 당시 분류를 기준으로 삼기 위함이며, 최초 건에 카테고리가
    비어 있을 때만 그다음으로 오래된 값으로 대체한다. parent_id <= 100000은 내부 테스트
    계정(compute_repeat_parents와 동일 기준)이라 채택하지 않는다. 언급이 1건뿐인 티켓도
    결과에 포함한다 — "여러번 인입"(cs_count > 1) 여부는 호출부가 필요에 따라 걸러 쓴다.
    limit은 기본적으로 없다 — "전체 티켓" 요약이 실제 전체 건수를 반영해야 해서, 예전처럼
    CS 건수 상위 N개만 남기고 나머지를 버리면 안 된다."""
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
            # rows가 최신순이라, category는 매번 값이 있을 때 덮어써서 마지막에 처리되는(=가장
            # 오래된) 값이 최종적으로 남게 한다 — "최초 인입 카테고리" 기준.
            if r["new_category_main"]:
                entry["category"] = r["new_category_main"]

    result = [
        {"ticket_id": tid, "cs_count": info["cs_count"], "latest_date": info["latest_date"],
         "first_date": info["first_date"], "memos": info["memos"], "student_id": info["student_id"],
         "parent_id": info["parent_id"], "category": info["category"]}
        for tid, info in counts.items()
    ]
    result.sort(key=lambda x: -x["cs_count"])
    return result[:limit] if limit else result


def compute_wings_tickets(start_date: str, end_date: str, limit: int | None = None) -> list:
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


_CLOSED_WINGS_STATES = ("해결", "요청취소", "merged")


def compute_wings_delay_counts(wings: list, today: date | None = None) -> tuple[int, int]:
    """상태가 채워진 wings 티켓 목록(update_wings_cache가 만든 형태)에서 (7일 이상 처리 지연
    건수, 30일 이상 처리 지연 건수)를 센다. today를 안 넘기면 실행 시점의 오늘 날짜를 쓴다
    (테스트에서는 고정 날짜를 넘겨 검증한다)."""
    today = today or date.today()
    delayed_7 = 0
    delayed_30 = 0
    for t in wings:
        if t.get("state") in _CLOSED_WINGS_STATES:
            continue
        first_date = t.get("first_date")
        if not first_date:
            continue
        diff_days = (today - datetime.fromisoformat(first_date[:10]).date()).days
        if diff_days >= 7:
            delayed_7 += 1
        if diff_days >= 30:
            delayed_30 += 1
    return delayed_7, delayed_30


def compute_wings_snapshot_counts(wings: list, today: date | None = None) -> dict:
    """주간보고서 "장기미해결 CS 현황" 카드용 스냅샷 4종. 반복 Wings 티켓 페이지의 KPI
    카드(미해결 티켓/2회 이상 인입/7일 이상 처리 지연/30일 이상 처리 지연)와 동일한 기준으로
    센다. wings는 update_wings_cache가 만든 형태(state 포함, 해결·요청취소·merged 티켓도
    섞여 있음)."""
    unresolved = [t for t in wings if t.get("state") not in _CLOSED_WINGS_STATES]
    delayed_7, delayed_30 = compute_wings_delay_counts(wings, today)
    return {
        "unresolved_count": len(unresolved),
        "repeat_count": sum(1 for t in unresolved if t.get("cs_count", 0) > 1),
        "delayed_7_count": delayed_7,
        "delayed_30_count": delayed_30,
    }


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


def _repeat_parents_qualifying_memos(parent: dict, cutoff: date) -> list:
    """parent(compute_repeat_parents가 만든 형태)의 memos 중 cutoff 이후(포함) 날짜만 남긴다.
    RepeatParents.tsx의 getQualifyingMemos()와 동일 — 카테고리로는 좁히지 않고 날짜로만 거른다."""
    out = []
    for m in parent.get("memos", []):
        d = m.get("date")
        if not d:
            continue
        try:
            memo_date = datetime.fromisoformat(d[:10]).date()
        except ValueError:
            continue
        if memo_date >= cutoff:
            out.append(m)
    return out


def compute_repeat_parents_snapshot_counts(parents: list, today: date | None = None) -> dict:
    """주간보고서 "반복 상담 학부모 현황" 카드용 스냅샷 4종. RepeatParents.tsx의 KPI 카드와
    동일한 기준으로 센다 — parents는 compute_repeat_parents()가 만든 형태(카테고리 무관하게
    최근 180일 내 3회 이상 후보)라, 여기서 최근 90일보다 오래된 메모를 걸러내고 다시 판정한다.
    그 결과 180일 기준으로는 후보였어도 최근 90일 안에 3건이 안 되면 더 이상 카운트되지 않는다."""
    today = today or date.today()
    cutoff = today - timedelta(days=90)

    qualified = [p for p in parents if len(_repeat_parents_qualifying_memos(p, cutoff)) >= 3]

    def has_consecutive_repeat(p: dict) -> bool:
        memos = sorted(_repeat_parents_qualifying_memos(p, cutoff), key=lambda m: m["date"])
        return any(memos[i]["category"] == memos[i - 1]["category"] for i in range(1, len(memos)))

    def has_recent_short_gap(p: dict) -> bool:
        dates = sorted(
            (datetime.fromisoformat(m["date"][:10]).date() for m in _repeat_parents_qualifying_memos(p, cutoff)),
            reverse=True,
        )
        return len(dates) >= 2 and (dates[0] - dates[1]).days <= 7

    def is_complex_issue(p: dict) -> bool:
        mains = {m["category"].split(" > ")[0] for m in _repeat_parents_qualifying_memos(p, cutoff)}
        return len(mains) >= 3

    return {
        "total_count": len(qualified),
        "repeat_count": sum(1 for p in qualified if has_consecutive_repeat(p)),
        "shortgap_count": sum(1 for p in qualified if has_recent_short_gap(p)),
        "complex_count": sum(1 for p in qualified if is_complex_issue(p)),
    }
