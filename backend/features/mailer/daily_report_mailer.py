# -*- coding: utf-8 -*-
# 설정된 시각에 직전 영업일 일별 보고서를 메일로 발송하는 오케스트레이션 로직.
# 발송 시각·마감 시각·발신자·수신자·on/off는 관리자 페이지("메일링 관리")에서 설정한 값을
# core/mail_settings.py를 통해 매번 새로 읽어온다 — 코드에 고정값으로 박아두지 않는다.
# 실제 스케줄 등록/시각 반영은 features/collection/scheduler.py가 담당한다.
#
# 흐름: on/off 확인 → target_date 결정(직접 지정 안 하면 휴무일 확인 후 직전 영업일 계산) →
#   이미 발송됐는지 확인(아니면 스킵, 중복 발송 방지) → 보고서 존재·마감시간 이내 생성
#   확인(아니면 스킵) → 보고서 페이지 스크린샷 캡쳐 → 메일 조립·발송 → 감사 로그 기록.
#   모든 결과(성공/스킵/실패)를 감사 로그에 남긴다.
#
# "이미 발송됐는지" 확인이 필요한 이유: 메일링을 꺼둔 채로 발송 시각을 넘긴 뒤 다시 켜서
# 저장하면(mail_endpoints.py) 그 자리에서 즉시 한 번 재시도 발송한다 — 그 뒤 관리자가
# 설정을 다시 저장하거나 스케줄러가 같은 날 또 실행되더라도, 이미 보낸 걸 또 보내면 안 되므로
# 감사 로그에서 이 target_date의 status=sent 여부를 먼저 확인한다.
#
# mode="manual"(관리자 페이지의 "테스트 발송")일 때는 메일링 on/off, 휴무일 확인, 마감 시간
# 확인을 모두 건너뛴다 — 셋 다 "평소 자동 스케줄이 지금 실행돼도 되는가"를 판단하는 조건이지,
# "이 보고서를 지금 강제로 보내보고 싶다"는 테스트 의도와는 무관하기 때문이다. 보고서 자체가
# 없으면(스크린샷 찍을 대상이 없으므로) mode와 무관하게 항상 스킵한다.
#
# recipient_override: 테스트 발송 전용 수신자. 저장된 자동 발송 수신자(settings["recipients"])와
# 완전히 별개다 — 테스트할 때마다 저장된 실제 수신자에게 매번 메일이 가면 곤란하므로, 관리자
# 페이지의 "테스트 발송"에서 별도로 입력받은 주소로만 보낸다. 이메일 내용 자체에는 "테스트
# 발송"이라는 표시를 넣지 않는다 — 실제 발송과 똑같은 내용을 확인해야 의미가 있기 때문이다.
import os
from datetime import date

from core.holidays import previous_business_day, is_off_day
from core.mail_settings import get_mail_settings, report_ready_by_deadline
from core.audit_log import log_action, was_already_logged
from features.report.report_daily import get_report
from features.mailer.report_screenshot import capture_report_screenshot
from features.mailer.mail_client import send_mail

_SERVICE_NAME = "공감센터 CS 대시보드"
_REPORT_PUBLIC_BASE_URL = os.environ.get("REPORT_PUBLIC_BASE_URL", "http://localhost:8092")
_IMAGE_CID = "daily_report_capture"
_DEFAULT_SENDER = os.environ.get("MAIL_FROM", "")


# "2026년 8월 24일" 형식 라벨 — weekly_report_mailer.py의 _week_label과 같은 이유로, 메일은
# 화면과 달리 맥락 없이 제목·본문만 단독으로 보이므로 연도까지 붙인다.
def _date_label(target_date: str) -> str:
    d = date.fromisoformat(target_date)
    return f"{d.year}년 {d.month}월 {d.day}일"


def _build_html_body(target_date: str, report_link: str) -> str:
    return (
        f"<p>안녕하세요.</p>"
        f"<p>{_date_label(target_date)} 일별 CS 보고서 전달드립니다.</p>"
        f'<p><a href="{report_link}">{report_link}</a></p>'
        f'<p><img src="cid:{_IMAGE_CID}" style="width:100%; height:auto; display:block;"></p>'
        f"<p>감사합니다.</p>"
    )


async def send_daily_report_mail(target_date: str | None = None, mode: str = "auto", recipient_override: list[str] | None = None) -> None:
    settings = get_mail_settings("daily")
    if mode != "manual" and not settings["enabled"]:
        log_action("daily_report_mail", "status=skipped, reason=메일링 꺼짐", mode=mode)
        return
    recipients = recipient_override or settings["recipients"]
    if not recipients:
        log_action("daily_report_mail", "status=skipped, reason=수신자 미설정", mode=mode)
        return

    if target_date is None:
        today = date.today().isoformat()
        if mode != "manual" and is_off_day(today):
            log_action("daily_report_mail", f"date={today}, status=skipped, reason=휴무일", mode=mode)
            return
        target_date = previous_business_day(today)

    if mode != "manual" and was_already_logged("daily_report_mail", f"date={target_date}, status=sent"):
        log_action("daily_report_mail", f"date={target_date}, status=skipped, reason=이미 발송됨", mode=mode)
        return

    report = get_report(target_date)
    if report is None:
        log_action("daily_report_mail", f"date={target_date}, status=skipped, reason=보고서 없음", mode=mode)
        return
    if mode != "manual" and not report_ready_by_deadline(report["generated_at"], settings["deadline_hour"], settings["deadline_minute"]):
        log_action("daily_report_mail", f"date={target_date}, status=skipped, reason=마감 시간 초과", mode=mode)
        return

    sender = settings["sender_email"] or _DEFAULT_SENDER
    recipient = ", ".join(recipients)
    report_link = f"{_REPORT_PUBLIC_BASE_URL}/report/daily?date={target_date}"
    try:
        image_bytes = await capture_report_screenshot("daily", target_date)
        html_body = _build_html_body(target_date, report_link)
        send_mail(f"[{_SERVICE_NAME}] {_date_label(target_date)} 일별 CS 보고서", html_body, sender, recipient, _IMAGE_CID, image_bytes)
    except Exception as e:
        log_action("daily_report_mail", f"date={target_date}, status=failed, error={e}", mode=mode)
        return
    log_action("daily_report_mail", f"date={target_date}, status=sent", mode=mode)
