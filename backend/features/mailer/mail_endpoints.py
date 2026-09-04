# -*- coding: utf-8 -*-
# 보고서 메일링 설정 API 라우터. 관리자 페이지("메일링 관리")가 사용한다.
#
# GET  /api/mail-settings?report_type=daily|weekly  : 저장된 설정 조회 (없으면 기본값 반환).
# POST /api/mail-settings                            : 설정 저장 + 그 즉시 스케줄 재등록
#   (서버 재시작 없이 다음 발송부터 바뀐 시각·수신자 등이 반영된다). 마감 시각이 발송 시각보다
#   MIN_DEADLINE_SEND_GAP_MINUTES(10분) 이상 앞서 있지 않으면 400으로 거부한다 — 마감에 딱
#   맞춰 만들어진 보고서를 스크린샷 찍고 발송까지 끝낼 시간을 최소한으로 확보하기 위함.
# POST /api/mail-settings/test?report_type=daily|weekly&date=YYYY-MM-DD&to=a@x.com,b@x.com :
#   (디버그·특정 상황용) 발송 시각을 기다리지 않고 즉시 한 번 실행한다. date를 안 넘기면 평소
#   스케줄과 똑같이 "직전 영업일"(daily)/"직전 주"(weekly)로 자동 계산한다. date를 넘기면 그
#   날짜(주간은 해당 주 월요일 날짜)로 강제 지정한다 — 감사 로그에는 mode='manual'로 남는다
#   (자동 스케줄 실행과 구분하기 위함). to는 필수 — 저장된 자동 발송 수신자와 완전히 별개로,
#   테스트할 때마다 실제 수신자에게 잘못 나가는 일이 없도록 매번 명시적으로 받는다.
#
# DELETE /api/mail-settings?report_type=daily|weekly : 저장된 설정을 지우고 기본값으로
#   되돌린다(core/mail_settings.py의 DEFAULTS). 스케줄도 기본 발송 시각으로 즉시 재등록한다.
#
# 발신 이력은 별도 API 없음 — 기존 GET /api/audit/log를 action='daily_report_mail'/
# 'weekly_report_mail'로 프론트에서 필터링해서 그대로 쓴다 (감사 로그에 이미 다 남고 있음).
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from core.mail_settings import (
    get_mail_settings, save_mail_settings, reset_mail_settings, parse_recipients,
    has_min_deadline_gap, MIN_DEADLINE_SEND_GAP_MINUTES,
    is_allowed_recipient, ALLOWED_RECIPIENT_DOMAIN, VALID_WEEKDAYS,
)
from features.admin.admin_endpoints import require_admin
from features.collection.scheduler import reschedule_mail_job

router = APIRouter()

_REPORT_TYPES = {"daily", "weekly"}


class MailSettingsBody(BaseModel):
    report_type: str
    enabled: bool
    deadline_hour: int
    deadline_minute: int
    send_hour: int
    send_minute: int
    sender_email: str
    recipients: list[str]
    send_weekday: str = "mon"


@router.get("/api/mail-settings")
def get_settings(report_type: str = Query(...), _: None = Depends(require_admin)):
    if report_type not in _REPORT_TYPES:
        raise HTTPException(status_code=400, detail="report_type은 daily 또는 weekly여야 합니다")
    return get_mail_settings(report_type)


@router.post("/api/mail-settings")
def update_settings(body: MailSettingsBody, _: None = Depends(require_admin)):
    if body.report_type not in _REPORT_TYPES:
        raise HTTPException(status_code=400, detail="report_type은 daily 또는 weekly여야 합니다")
    if not has_min_deadline_gap(body.deadline_hour, body.deadline_minute, body.send_hour, body.send_minute):
        raise HTTPException(
            status_code=400,
            detail=f"보고서 마감 시각은 발송 시각보다 최소 {MIN_DEADLINE_SEND_GAP_MINUTES}분 이상 앞서 있어야 합니다",
        )
    if any(not is_allowed_recipient(r) for r in body.recipients):
        raise HTTPException(status_code=400, detail=f"@{ALLOWED_RECIPIENT_DOMAIN} 외에는 발송이 불가합니다")
    if body.send_weekday not in VALID_WEEKDAYS:
        raise HTTPException(status_code=400, detail="send_weekday는 mon~sun 중 하나여야 합니다")
    save_mail_settings(body.report_type, body.model_dump(exclude={"report_type"}))
    reschedule_mail_job(body.report_type)
    return get_mail_settings(body.report_type)


@router.delete("/api/mail-settings")
def reset_settings(report_type: str = Query(...), _: None = Depends(require_admin)):
    if report_type not in _REPORT_TYPES:
        raise HTTPException(status_code=400, detail="report_type은 daily 또는 weekly여야 합니다")
    reset_mail_settings(report_type)
    reschedule_mail_job(report_type)
    return get_mail_settings(report_type)


@router.post("/api/mail-settings/test")
async def test_send(
    report_type: str = Query(...), date: str | None = Query(default=None),
    to: str = Query(...), _: None = Depends(require_admin),
):
    recipients = parse_recipients(to)
    if not recipients:
        raise HTTPException(status_code=400, detail="테스트 수신자를 입력해주세요")
    if any(not is_allowed_recipient(r) for r in recipients):
        raise HTTPException(status_code=400, detail=f"@{ALLOWED_RECIPIENT_DOMAIN} 외에는 발송이 불가합니다")
    if report_type == "daily":
        from features.mailer.daily_report_mailer import send_daily_report_mail
        await send_daily_report_mail(target_date=date, mode="manual", recipient_override=recipients)
    elif report_type == "weekly":
        from features.mailer.weekly_report_mailer import send_weekly_report_mail
        await send_weekly_report_mail(week_start=date, mode="manual", recipient_override=recipients)
    else:
        raise HTTPException(status_code=400, detail="report_type은 daily 또는 weekly여야 합니다")
    return {"triggered": True}
