# -*- coding: utf-8 -*-
# core/mail_settings.py의 parse_recipients()/report_ready_by_deadline()/is_allowed_recipient()
# 유닛 테스트.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.mail_settings import parse_recipients, report_ready_by_deadline, has_min_deadline_gap, is_allowed_recipient


class TestParseRecipients:
    def test_splits_comma_separated(self):
        assert parse_recipients("a@x.com,b@x.com") == ["a@x.com", "b@x.com"]

    def test_trims_whitespace(self):
        assert parse_recipients(" a@x.com , b@x.com ") == ["a@x.com", "b@x.com"]

    def test_drops_empty_parts(self):
        assert parse_recipients("a@x.com,,b@x.com,") == ["a@x.com", "b@x.com"]

    def test_empty_string_returns_empty_list(self):
        assert parse_recipients("") == []


class TestReportReadyByDeadline:
    def test_generated_before_deadline_is_ready(self):
        assert report_ready_by_deadline("2026-08-25 09:30:00", 11, 0, today="2026-08-25") is True

    def test_generated_exactly_at_deadline_is_ready(self):
        assert report_ready_by_deadline("2026-08-25 11:00:00", 11, 0, today="2026-08-25") is True

    def test_generated_after_deadline_is_not_ready(self):
        assert report_ready_by_deadline("2026-08-25 11:30:00", 11, 0, today="2026-08-25") is False

    def test_generated_after_deadline_minute_is_not_ready(self):
        assert report_ready_by_deadline("2026-08-25 11:05:00", 11, 0, today="2026-08-25") is False

    def test_generated_on_earlier_day_is_ready_even_past_deadline_time(self):
        # 관리자가 전날 오후에 미리 생성해둔 경우 — 시:분만 보면 마감을 넘겼어도
        # 날짜 자체가 오늘보다 이르므로 준비된 것으로 봐야 한다.
        assert report_ready_by_deadline("2026-08-26 16:38:00", 12, 0, today="2026-08-27") is True

    def test_generated_on_later_day_is_not_ready(self):
        assert report_ready_by_deadline("2026-08-27 09:00:00", 12, 0, today="2026-08-26") is False


class TestHasMinDeadlineGap:
    def test_exactly_10_minutes_apart_is_valid(self):
        assert has_min_deadline_gap(10, 50, 11, 0) is True

    def test_more_than_10_minutes_apart_is_valid(self):
        assert has_min_deadline_gap(10, 0, 11, 0) is True

    def test_less_than_10_minutes_apart_is_invalid(self):
        assert has_min_deadline_gap(10, 55, 11, 0) is False

    def test_deadline_same_as_send_is_invalid(self):
        assert has_min_deadline_gap(11, 0, 11, 0) is False

    def test_deadline_after_send_is_invalid(self):
        assert has_min_deadline_gap(11, 30, 11, 0) is False

    def test_gap_across_hour_boundary(self):
        assert has_min_deadline_gap(9, 56, 10, 5) is False
        assert has_min_deadline_gap(9, 55, 10, 5) is True


class TestIsAllowedRecipient:
    def test_allows_danbiedu_domain(self):
        assert is_allowed_recipient("jylee@danbiedu.co.kr") is True

    def test_blocks_other_domain(self):
        assert is_allowed_recipient("jylee@gmail.com") is False

    def test_is_case_insensitive(self):
        assert is_allowed_recipient("jylee@DANBIEDU.CO.KR") is True

    def test_ignores_surrounding_whitespace(self):
        assert is_allowed_recipient("  jylee@danbiedu.co.kr  ") is True

    def test_blocks_lookalike_subdomain(self):
        assert is_allowed_recipient("jylee@danbiedu.co.kr.evil.com") is False
