# -*- coding: utf-8 -*-
# 해지 방어 성과 분석 전용 집계 로직.
# "해지·유지 상담" 안의 "해지 방어"/"해지 확정" 서브카테고리 건수로 방어 성공률(save rate)을 계산하고,
# 방어 성공 메모에 남는 "-성공(<오퍼명>)" 구조화 필드에서 어떤 리텐션 오퍼(기존학습유지·과목전환 등)가
# 가장 많이 쓰였는지 집계한다. 오퍼 필드가 없는 방어 건은 unlabeled_count로만 남기고 집계에서 제외한다.
import re
from collections import Counter

from core.db import get_conn

_OFFER = re.compile(r"-성공\(([^)\n]+)\)")
MAX_EXAMPLES = 30


def extract_retention_offer(memo: str) -> str | None:
    """해지 방어 메모의 "-성공(<오퍼명>)" 필드 값을 추출. 필드 없거나 괄호가 안 닫히면 None."""
    m = _OFFER.search(memo)
    if not m:
        return None
    val = re.sub(r"\s+", "", m.group(1)).strip()
    return val or None


def get_retention_stats() -> dict:
    with get_conn() as conn:
        defense_rows = conn.execute(
            "SELECT id, datetime(created_date, '+9 hours') AS kst_date, call_memo "
            "FROM issues WHERE new_category_sub = '해지 방어'"
        ).fetchall()
        confirmed_count = conn.execute(
            "SELECT COUNT(*) c FROM issues WHERE new_category_sub = '해지 확정'"
        ).fetchone()["c"]

    defense_count = len(defense_rows)
    total_attempts = defense_count + confirmed_count
    save_rate = round(defense_count / total_attempts * 100, 1) if total_attempts else 0.0

    offer_counts: Counter = Counter()
    offer_rows: dict[str, list[dict]] = {}
    unlabeled = 0
    for r in defense_rows:
        offer = extract_retention_offer(r["call_memo"])
        if offer is None:
            unlabeled += 1
            continue
        offer_counts[offer] += 1
        offer_rows.setdefault(offer, []).append({
            "id": r["id"],
            "created_date": r["kst_date"],
            "memo": r["call_memo"],
        })

    return {
        "defense_count": defense_count,
        "confirmed_count": confirmed_count,
        "save_rate": save_rate,
        "unlabeled_count": unlabeled,
        "offers": [
            {
                "name": name,
                "count": count,
                "examples": [
                    {"id": it["id"], "created_date": it["created_date"], "memo": it["memo"]}
                    for it in sorted(offer_rows[name], key=lambda x: x["created_date"], reverse=True)[:MAX_EXAMPLES]
                ],
            }
            for name, count in offer_counts.most_common()
        ],
    }
