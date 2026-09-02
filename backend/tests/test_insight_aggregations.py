# -*- coding: utf-8 -*-
# features/insights/insight_aggregations.py의 group_wings_tickets() 유닛 테스트.
# DB 조회(compute_wings_tickets)는 제외하고, 이미 조회된 행을 Wings 티켓 ID별로 묶어
# parent_id·카테고리·건수를 집계하는 순수 로직만 검증한다. 이 티켓 목록은 미해결 버그
# 트래킹(원래 표)과 가정별 이탈 위험 섹션(카테고리·주간 추이) 양쪽에서 같이 쓰인다.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from features.insights.insight_aggregations import group_wings_tickets

TICKET = "wings.danbiedu.co.kr/#ticket/zoom/1234"


def row(kst_date, memo, parent_id=None, category=None, student_id=None):
    return {"kst_date": kst_date, "call_memo": memo, "parent_id": parent_id,
            "new_category_main": category, "student_id": student_id}


class TestGroupWingsTickets:
    def test_single_mention_included_with_count_one(self):
        # "전체 티켓" 집계에 필요해서 언급 1건짜리도 포함한다 — "여러번 인입" 여부는 호출부가
        # cs_count > 1로 따로 판단한다.
        rows = [row("2026-08-20 10:00:00", f"문의 {TICKET}", parent_id=200001, category="기기·하드웨어 오류")]
        result = group_wings_tickets(rows)
        assert len(result) == 1
        assert result[0]["cs_count"] == 1

    def test_two_or_more_mentions_included_with_count(self):
        rows = [
            row("2026-08-22 10:00:00", f"재문의 {TICKET}", parent_id=200001, category="기기·하드웨어 오류"),
            row("2026-08-20 10:00:00", f"문의 {TICKET}", parent_id=200001, category="기기·하드웨어 오류"),
        ]
        result = group_wings_tickets(rows)
        assert len(result) == 1
        assert result[0]["cs_count"] == 2
        assert result[0]["parent_id"] == 200001
        assert result[0]["category"] == "기기·하드웨어 오류"
        assert len(result[0]["memos"]) == 2

    def test_first_date_is_earliest_latest_date_is_most_recent(self):
        # rows는 실제 쿼리와 동일하게 kst_date 내림차순(최신 먼저)으로 들어온다고 가정
        rows = [
            row("2026-08-25 09:00:00", f"3차 {TICKET}"),
            row("2026-08-22 09:00:00", f"2차 {TICKET}"),
            row("2026-08-18 09:00:00", f"1차 {TICKET}"),
        ]
        result = group_wings_tickets(rows)
        assert result[0]["latest_date"] == "2026-08-25 09:00:00"
        assert result[0]["first_date"] == "2026-08-18 09:00:00"

    def test_student_id_from_first_available_row(self):
        rows = [
            row("2026-08-22 09:00:00", f"2차 {TICKET}", student_id=None),
            row("2026-08-18 09:00:00", f"1차 {TICKET}", student_id="1234567"),
        ]
        result = group_wings_tickets(rows)
        assert result[0]["student_id"] == "1234567"

    def test_missing_parent_id_on_first_row_falls_back_to_later_row(self):
        rows = [
            row("2026-08-22 09:00:00", f"2차 {TICKET}", parent_id=None),
            row("2026-08-18 09:00:00", f"1차 {TICKET}", parent_id=200000),
        ]
        result = group_wings_tickets(rows)
        assert result[0]["parent_id"] == 200000

    def test_internal_test_account_parent_id_excluded(self):
        # parent_id <= 100000은 내부 테스트 계정 — compute_repeat_parents와 같은 기준으로 채택하지 않는다
        rows = [
            row("2026-08-22 09:00:00", f"2차 {TICKET}", parent_id=92),
            row("2026-08-18 09:00:00", f"1차 {TICKET}", parent_id=100000),
        ]
        result = group_wings_tickets(rows)
        assert result[0]["parent_id"] is None

    def test_sorted_by_cs_count_descending(self):
        low_ticket = "wings.danbiedu.co.kr/#ticket/zoom/1"
        high_ticket = "wings.danbiedu.co.kr/#ticket/zoom/2"
        rows = [
            row("2026-08-22 09:00:00", f"{low_ticket} {low_ticket}"),
            row("2026-08-21 09:00:00", f"{high_ticket}"),
            row("2026-08-20 09:00:00", f"{high_ticket}"),
            row("2026-08-19 09:00:00", f"{high_ticket}"),
        ]
        result = group_wings_tickets(rows)
        assert [r["ticket_id"] for r in result] == ["2", "1"]

    def test_different_tickets_grouped_separately(self):
        other_ticket = "wings.danbiedu.co.kr/#ticket/zoom/5678"
        rows = [
            row("2026-08-22 09:00:00", f"{TICKET}"),
            row("2026-08-21 09:00:00", f"{TICKET}"),
            row("2026-08-20 09:00:00", f"{other_ticket}"),
            row("2026-08-19 09:00:00", f"{other_ticket}"),
        ]
        result = group_wings_tickets(rows)
        assert len(result) == 2
        assert {r["ticket_id"] for r in result} == {"1234", "5678"}

    def test_limit_caps_result_count(self):
        rows = []
        for i in range(5):
            t = f"wings.danbiedu.co.kr/#ticket/zoom/{i}"
            rows.append(row("2026-08-21 09:00:00", t))
            rows.append(row("2026-08-20 09:00:00", t))
        result = group_wings_tickets(rows, limit=2)
        assert len(result) == 2
