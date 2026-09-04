# -*- coding: utf-8 -*-
# features/insights/insight_aggregations.py의 group_wings_tickets()·compute_wings_delay_counts()·
# compute_wings_snapshot_counts() 유닛 테스트. DB 조회(compute_wings_tickets)는 제외하고, 이미
# 조회된 행을 Wings 티켓 ID별로 묶어 parent_id·카테고리·건수를 집계하는 순수 로직과, 그 결과에서
# 7일+/30일+ 처리 지연 건수를 세는 로직, 주간보고서 "장기미해결 CS 현황" 카드용 스냅샷 4종
# (미해결/반복/7일+/30일+)을 세는 로직을 검증한다. 이 티켓 목록은 미해결 버그 트래킹(원래 표)과
# 가정별 이탈 위험 섹션(카테고리·주간 추이) 양쪽에서 같이 쓰인다.
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from features.insights.insight_aggregations import (
    group_wings_tickets, compute_wings_delay_counts, compute_wings_snapshot_counts,
    compute_repeat_parents_snapshot_counts,
)

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

    def test_category_uses_earliest_mention_not_latest(self):
        # 처음 접수 당시 분류를 기준으로 삼는다 — 나중에 재분류돼도 최초 카테고리를 유지한다.
        rows = [
            row("2026-08-22 09:00:00", f"2차 {TICKET}", category="기타"),
            row("2026-08-18 09:00:00", f"1차 {TICKET}", category="기기·하드웨어 오류"),
        ]
        result = group_wings_tickets(rows)
        assert result[0]["category"] == "기기·하드웨어 오류"

    def test_category_falls_back_when_earliest_row_has_no_category(self):
        rows = [
            row("2026-08-25 09:00:00", f"3차 {TICKET}", category=None),
            row("2026-08-22 09:00:00", f"2차 {TICKET}", category="기기·하드웨어 오류"),
            row("2026-08-18 09:00:00", f"1차 {TICKET}", category=None),
        ]
        result = group_wings_tickets(rows)
        assert result[0]["category"] == "기기·하드웨어 오류"

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

    def test_no_limit_by_default_returns_all_tickets(self):
        # "전체 티켓" 요약이 실제 전체 건수를 반영해야 해서, limit을 안 넘기면 CS 건수 상위
        # 몇 개로 잘리지 않고 언급된 티켓이 전부 나와야 한다.
        rows = [row("2026-08-21 09:00:00", f"wings.danbiedu.co.kr/#ticket/zoom/{i}") for i in range(60)]
        result = group_wings_tickets(rows)
        assert len(result) == 60


def ticket(state, first_date, cs_count=1):
    return {"state": state, "first_date": first_date, "cs_count": cs_count}


class TestComputeWingsSnapshotCounts:
    TODAY = date(2026, 9, 3)

    def test_empty_list_returns_all_zero(self):
        assert compute_wings_snapshot_counts([], today=self.TODAY) == {
            "unresolved_count": 0, "repeat_count": 0, "delayed_7_count": 0, "delayed_30_count": 0,
        }

    def test_closed_tickets_excluded_from_unresolved_and_repeat(self):
        rows = [ticket("해결", "2026-01-01", cs_count=5), ticket("merged", "2026-01-01", cs_count=3)]
        result = compute_wings_snapshot_counts(rows, today=self.TODAY)
        assert result["unresolved_count"] == 0
        assert result["repeat_count"] == 0

    def test_single_mention_ticket_not_counted_as_repeat(self):
        rows = [ticket("신규", "2026-09-02", cs_count=1)]
        result = compute_wings_snapshot_counts(rows, today=self.TODAY)
        assert result["unresolved_count"] == 1
        assert result["repeat_count"] == 0

    def test_repeat_ticket_counted_in_both_unresolved_and_repeat(self):
        rows = [ticket("진행 중", "2026-09-02", cs_count=2)]
        result = compute_wings_snapshot_counts(rows, today=self.TODAY)
        assert result["unresolved_count"] == 1
        assert result["repeat_count"] == 1

    def test_delayed_counts_match_compute_wings_delay_counts(self):
        rows = [ticket("진행 중", "2026-08-20", cs_count=1), ticket("결과 확인 중", "2026-07-01", cs_count=2)]
        result = compute_wings_snapshot_counts(rows, today=self.TODAY)
        assert result["delayed_7_count"] == 2
        assert result["delayed_30_count"] == 1

    def test_mixed_snapshot(self):
        rows = [
            ticket("신규", "2026-09-02", cs_count=1),          # 미해결, 반복 아님, 지연 아님
            ticket("진행 중", "2026-08-20", cs_count=3),        # 미해결, 반복, 7일↑
            ticket("결과 확인 중", "2026-07-01", cs_count=2),   # 미해결, 반복, 7·30일↑
            ticket("해결", "2026-01-01", cs_count=9),           # 해결이라 전부 제외
        ]
        result = compute_wings_snapshot_counts(rows, today=self.TODAY)
        assert result == {
            "unresolved_count": 3, "repeat_count": 2, "delayed_7_count": 2, "delayed_30_count": 1,
        }


class TestComputeWingsDelayCounts:
    TODAY = date(2026, 9, 3)

    def test_empty_list_returns_zero_zero(self):
        assert compute_wings_delay_counts([], today=self.TODAY) == (0, 0)

    def test_closed_ticket_excluded_even_if_very_old(self):
        rows = [ticket("해결", "2026-01-01"), ticket("요청취소", "2026-01-01"), ticket("merged", "2026-01-01")]
        assert compute_wings_delay_counts(rows, today=self.TODAY) == (0, 0)

    def test_under_7_days_not_counted(self):
        rows = [ticket("신규", "2026-09-01")]  # 2일 경과
        assert compute_wings_delay_counts(rows, today=self.TODAY) == (0, 0)

    def test_between_7_and_29_days_counted_only_in_7(self):
        rows = [ticket("진행 중", "2026-08-20")]  # 14일 경과
        assert compute_wings_delay_counts(rows, today=self.TODAY) == (1, 0)

    def test_30_days_or_more_counted_in_both(self):
        rows = [ticket("결과 확인 중", "2026-07-20")]  # 45일 경과
        assert compute_wings_delay_counts(rows, today=self.TODAY) == (1, 1)

    def test_mixed_tickets_summed_correctly(self):
        rows = [
            ticket("신규", "2026-09-02"),          # 1일 - 미포함
            ticket("진행 중", "2026-08-25"),        # 9일 - 7일만
            ticket("결과 확인 중", "2026-07-01"),   # 64일 - 둘 다
            ticket("해결", "2026-01-01"),           # 해결이라 제외
        ]
        assert compute_wings_delay_counts(rows, today=self.TODAY) == (2, 1)


def parent(memos):
    return {"parent_id": 999999, "cs_count": len(memos), "categories": [], "memos": memos,
            "latest_date": memos[-1]["date"] if memos else None}


def memo(date_str, category, text="메모"):
    return {"date": date_str, "memo": text, "category": category}


class TestComputeRepeatParentsSnapshotCounts:
    # RepeatParents.tsx와 반드시 같은 기준을 써야 하므로, 이 클래스의 today 기준(2026-09-03)에서
    # "최근 90일"은 2026-06-05 이후다.
    TODAY = date(2026, 9, 3)

    def test_empty_list_returns_all_zero(self):
        assert compute_repeat_parents_snapshot_counts([], today=self.TODAY) == {
            "total_count": 0, "repeat_count": 0, "shortgap_count": 0, "complex_count": 0,
        }

    def test_90일보다_오래된_메모만_있으면_자격_미달(self):
        p = parent([
            memo("2026-05-01 10:00:00", "네트워크·앱 오류 > 와이파이 오류"),
            memo("2026-05-05 10:00:00", "네트워크·앱 오류 > 앱 오류"),
            memo("2026-05-10 10:00:00", "기기·하드웨어 오류 > 충전 불량"),
        ])
        result = compute_repeat_parents_snapshot_counts([p], today=self.TODAY)
        assert result["total_count"] == 0

    def test_90일_이내_메모가_3건_이상이면_total에_포함(self):
        p = parent([
            memo("2026-07-01 10:00:00", "네트워크·앱 오류 > 와이파이 오류"),
            memo("2026-07-15 10:00:00", "네트워크·앱 오류 > 앱 오류"),
            memo("2026-08-01 10:00:00", "기기·하드웨어 오류 > 충전 불량"),
        ])
        result = compute_repeat_parents_snapshot_counts([p], today=self.TODAY)
        assert result["total_count"] == 1

    def test_인접한_두_상담이_같은_카테고리면_repeat에_포함(self):
        p = parent([
            memo("2026-07-01 10:00:00", "기기·하드웨어 오류 > 충전 불량"),
            memo("2026-07-10 10:00:00", "기기·하드웨어 오류 > 충전 불량"),
            memo("2026-08-01 10:00:00", "네트워크·앱 오류 > 와이파이 오류"),
        ])
        result = compute_repeat_parents_snapshot_counts([p], today=self.TODAY)
        assert result["repeat_count"] == 1

    def test_대분류만_같고_소분류가_다르면_repeat_아님(self):
        p = parent([
            memo("2026-07-01 10:00:00", "기기·하드웨어 오류 > 충전 불량"),
            memo("2026-07-10 10:00:00", "기기·하드웨어 오류 > 분실, 파손"),
            memo("2026-08-01 10:00:00", "네트워크·앱 오류 > 와이파이 오류"),
        ])
        result = compute_repeat_parents_snapshot_counts([p], today=self.TODAY)
        assert result["repeat_count"] == 0

    def test_가장_최근_두_상담_간격이_7일_이내면_shortgap에_포함(self):
        p = parent([
            memo("2026-07-01 10:00:00", "네트워크·앱 오류 > 와이파이 오류"),   # 가장 오래된 건 — 간격 계산과 무관
            memo("2026-08-20 10:00:00", "네트워크·앱 오류 > 앱 오류"),
            memo("2026-08-27 10:00:00", "기기·하드웨어 오류 > 충전 불량"),    # 바로 위와 7일 간격
        ])
        result = compute_repeat_parents_snapshot_counts([p], today=self.TODAY)
        assert result["shortgap_count"] == 1

    def test_대분류가_3개_이상이면_complex에_포함(self):
        p = parent([
            memo("2026-07-01 10:00:00", "네트워크·앱 오류 > 와이파이 오류"),
            memo("2026-07-15 10:00:00", "기기·하드웨어 오류 > 충전 불량"),
            memo("2026-08-01 10:00:00", "미납·결제 > 미납 관리"),
        ])
        result = compute_repeat_parents_snapshot_counts([p], today=self.TODAY)
        assert result["complex_count"] == 1

    def test_기타_카테고리도_다른_카테고리와_동일하게_카운트(self):
        p = parent([
            memo("2026-07-01 10:00:00", "기타 > 기타"),
            memo("2026-07-15 10:00:00", "기타 > 교사 상담 요청"),
            memo("2026-08-01 10:00:00", "체험 관련 > 중복 신청"),
        ])
        result = compute_repeat_parents_snapshot_counts([p], today=self.TODAY)
        assert result["total_count"] == 1
