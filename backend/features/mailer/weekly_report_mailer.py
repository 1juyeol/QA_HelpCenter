# -*- coding: utf-8 -*-
# 설정된 시각에 직전 주 주간 보고서를 메일로 발송하는 오케스트레이션 로직.
# daily_report_mailer.py와 구조가 같다 — 대상이 "직전 영업일"이 아니라 "직전 주 월요일"이고,
# 요일 제한 없이 관리자가 정한 요일·시각에 한 번 실행된다는 점만 다르다(주간 보고서는 매주
# 한 번 보내는 것이라 "휴무일이면 스킵" 개념 자체가 없다).
#
# week_start를 직접 넘기면(관리자 페이지의 "테스트 발송 — 주 선택") 그 주로 바로 보낸다.
# mode="manual"일 때는 메일링 on/off와 마감 시간 확인을 둘 다 건너뛴다 — "평소 자동 스케줄이
# 지금 실행돼도 되는가"를 보는 조건이라, "이 보고서를 지금 강제로 보내보고 싶다"는 테스트
# 의도와는 무관하기 때문이다.
#
# 이미 발송됐는지도 확인한다 — 메일링을 꺼둔 채로 발송 요일·시각을 넘긴 뒤 다시 켜서
# 저장하면(mail_endpoints.py) 그 자리에서 즉시 한 번 재시도 발송하는데, 그 뒤 스케줄러가
# 같은 주에 또 실행되거나 관리자가 설정을 다시 저장해도 같은 보고서를 중복 발송하면 안 되므로
# 감사 로그에서 이 week_start의 status=sent 여부를 먼저 확인한다.
#
# recipient_override: 테스트 발송 전용 수신자 — daily_report_mailer.py와 같은 이유로 저장된
# 자동 발송 수신자와 완전히 분리한다.
import os
from datetime import date, timedelta

from core.mail_settings import get_mail_settings, report_ready_by_deadline
from core.audit_log import log_action, was_already_logged
from features.report.report_weekly import get_weekly_report
from features.mailer.report_screenshot import capture_report_screenshot
from features.mailer.mail_client import send_mail

_SERVICE_NAME = "공감센터 CS 대시보드"
_REPORT_PUBLIC_BASE_URL = os.environ.get("REPORT_PUBLIC_BASE_URL", "http://localhost:8092")
_IMAGE_CID = "weekly_report_capture"
_DEFAULT_SENDER = os.environ.get("MAIL_FROM", "")


def _last_monday(today: date) -> str:
    return str(today - timedelta(days=today.weekday() + 7))


# "2026년 8월 3주차" 형식 라벨. 월/주차를 세는 방식은 frontend/src/pages/report/
# WeeklyReport.tsx의 getWeekLabel과 반드시 같아야 한다(Dashboard.tsx의 monthWeekLabel과는
# 다른 기준이니 그쪽을 가져다 쓰지 않도록 주의) — 다만 화면과 달리 메일은 다른 맥락 없이
# 제목·본문만 단독으로 보이므로, 일별 보고서 메일의 "YYYY-MM-DD" 표기처럼 연도까지 붙여
# 모호함이 없게 한다.
def _week_label(week_start: str) -> str:
    d = date.fromisoformat(week_start)
    first_day = date(d.year, d.month, 1)
    first_dow = (first_day.weekday() + 1) % 7  # JS getDay() 기준: 0=일 ~ 6=토
    days_to_first_mon = (1 - first_dow + 7) % 7
    first_mon_date = 1 + days_to_first_mon
    week_num = (d.day - first_mon_date) // 7 + 1
    return f"{d.year}년 {d.month}월 {week_num}주차"


def _build_html_body(week_start: str, report_link: str) -> str:
    return (
        f"<p>안녕하세요.</p>"
        f"<p>{_week_label(week_start)} 주간 CS 보고서 전달드립니다.</p>"
        f'<p><a href="{report_link}">{report_link}</a></p>'
        f'<p><img src="cid:{_IMAGE_CID}" style="width:100%; height:auto; display:block;"></p>'
        f"<p>감사합니다.</p>"
    )


async def send_weekly_report_mail(week_start: str | None = None, mode: str = "auto", recipient_override: list[str] | None = None) -> None:
    settings = get_mail_settings("weekly")
    if mode != "manual" and not settings["enabled"]:
        log_action("weekly_report_mail", "status=skipped, reason=메일링 꺼짐", mode=mode)
        return
    recipients = recipient_override or settings["recipients"]
    if not recipients:
        log_action("weekly_report_mail", "status=skipped, reason=수신자 미설정", mode=mode)
        return

    if week_start is None:
        week_start = _last_monday(date.today())

    if mode != "manual" and was_already_logged("weekly_report_mail", f"week_start={week_start}, status=sent"):
        log_action("weekly_report_mail", f"week_start={week_start}, status=skipped, reason=이미 발송됨", mode=mode)
        return

    report = get_weekly_report(week_start)
    if report is None:
        log_action("weekly_report_mail", f"week_start={week_start}, status=skipped, reason=보고서 없음", mode=mode)
        return
    if mode != "manual" and not report_ready_by_deadline(report["generated_at"], settings["deadline_hour"], settings["deadline_minute"]):
        log_action("weekly_report_mail", f"week_start={week_start}, status=skipped, reason=마감 시간 초과", mode=mode)
        return

    sender = settings["sender_email"] or _DEFAULT_SENDER
    recipient = ", ".join(recipients)
    report_link = f"{_REPORT_PUBLIC_BASE_URL}/report/weekly?week_start={week_start}"
    try:
        image_bytes = await capture_report_screenshot("weekly", week_start)
        html_body = _build_html_body(week_start, report_link)
        send_mail(f"[{_SERVICE_NAME}] {_week_label(week_start)} 주간 CS 보고서", html_body, sender, recipient, _IMAGE_CID, image_bytes)
    except Exception as e:
        log_action("weekly_report_mail", f"week_start={week_start}, status=failed, error={e}", mode=mode)
        return
    log_action("weekly_report_mail", f"week_start={week_start}, status=sent", mode=mode)
