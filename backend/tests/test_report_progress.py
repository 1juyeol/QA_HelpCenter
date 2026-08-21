# core/report_progress.py 유닛 테스트.
# 프로세스 메모리에 (report_type, date)별 진행 상태를 기록/조회하는 로직이 맞는지 검증.
from core import report_progress


def teardown_function(_):
    # 모듈 전역 dict를 테스트끼리 공유하므로 매 테스트 후 비운다.
    report_progress._progress.clear()


class TestReportProgress:
    def test_not_started_returns_none(self):
        assert report_progress.get_status("daily", "2026-08-19") is None
        assert report_progress.is_running("daily", "2026-08-19") is False

    def test_start_then_get_status(self):
        report_progress.start("daily", "2026-08-19", total_steps=5)
        status = report_progress.get_status("daily", "2026-08-19")
        assert status == {"running": True, "label": None, "step": 0, "total": 5}
        assert report_progress.is_running("daily", "2026-08-19") is True

    def test_update_changes_label_and_step(self):
        report_progress.start("daily", "2026-08-19", total_steps=5)
        report_progress.update("daily", "2026-08-19", "기기·하드웨어 오류", 2)
        status = report_progress.get_status("daily", "2026-08-19")
        assert status["label"] == "기기·하드웨어 오류"
        assert status["step"] == 2

    def test_finish_clears_status(self):
        report_progress.start("daily", "2026-08-19", total_steps=5)
        report_progress.finish("daily", "2026-08-19")
        assert report_progress.get_status("daily", "2026-08-19") is None
        assert report_progress.is_running("daily", "2026-08-19") is False

    def test_update_on_unstarted_date_is_noop(self):
        report_progress.update("daily", "2026-08-19", "기기·하드웨어 오류", 2)
        assert report_progress.get_status("daily", "2026-08-19") is None

    def test_different_dates_are_independent(self):
        report_progress.start("daily", "2026-08-19", total_steps=5)
        assert report_progress.is_running("daily", "2026-08-20") is False
        assert report_progress.get_status("daily", "2026-08-20") is None

    def test_different_report_types_are_independent(self):
        report_progress.start("daily", "2026-08-19", total_steps=5)
        assert report_progress.is_running("weekly", "2026-08-19") is False
