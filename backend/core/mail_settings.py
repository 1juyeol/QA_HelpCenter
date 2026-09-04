# -*- coding: utf-8 -*-
# 일별/주간 보고서 메일링 설정(on/off, 마감시간, 발송시각, 발신자, 수신자) 저장·조회.
# core/db.py의 mail_settings 테이블(report_type='daily'|'weekly' PK)을 그대로 쓴다 —
# collection_settings.py처럼 파일이 아니라 테이블인 이유는, 값이 하나가 아니라 report_type별로
# 여러 항목(시각 4개, 발신자, 수신자 목록)이 필요해서 단일 JSON보다 테이블이 자연스럽다.
# 아직 설정한 적 없는 report_type을 조회하면 DEFAULTS로 채워 반환한다(테이블에 행이 없어도 됨).
from datetime import date, datetime

from core.db import get_conn

DEFAULTS = {
    "enabled": True,
    "deadline_hour": 11,
    "deadline_minute": 0,
    "send_hour": 11,
    "send_minute": 0,
    "sender_email": "",
    "recipients": [],
    "send_weekday": "mon",
}

# APScheduler cron의 day_of_week 값 그대로 — 주간 보고서 메일링에서만 쓴다(일별은 매일 발송).
VALID_WEEKDAYS = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
_WEEKDAY_INDEX = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}


def has_daily_slot_passed(send_hour: int, send_minute: int, now: datetime | None = None) -> bool:
    """오늘의 발송 시각(send_hour:send_minute)이 이미 지났는지 판별한다. 메일링을 꺼둔 채로
    발송 시각을 넘긴 뒤 다시 켜서 저장하는 경우, 이 값이 True면 그 즉시 한 번 발송을
    시도해야 한다는 뜻이다(그러지 않으면 다음 날까지 그냥 넘어가 버린다)."""
    now = now or datetime.now()
    return (now.hour, now.minute) >= (send_hour, send_minute)


def has_weekly_slot_passed(send_weekday: str, send_hour: int, send_minute: int, now: datetime | None = None) -> bool:
    """이번 주의 발송 요일·시각이 이미 지났는지 판별한다. 지정 요일이 오늘보다 이전이면
    무조건 지난 것이고, 오늘이면 시각을 비교한다. 아직 안 온 요일이면 False — 이 경우는
    평소 스케줄이 알아서 그 요일에 발송하므로 즉시 재시도할 필요가 없다."""
    now = now or datetime.now()
    target = _WEEKDAY_INDEX[send_weekday]
    if now.weekday() > target:
        return True
    if now.weekday() < target:
        return False
    return (now.hour, now.minute) >= (send_hour, send_minute)

# 마감 시각과 발송 시각 사이에 최소한 이만큼(분)은 떨어져 있어야 한다. 너무 붙어있으면
# "마감 시각에 딱 맞춰 만들어진 보고서"를 스크린샷·발송까지 끝낼 시간이 부족해질 수 있다.
MIN_DEADLINE_SEND_GAP_MINUTES = 10

# 사내 메일 서버(gm.danbiedu.co.kr)가 외부 도메인으로의 발송을 상정하고 있지 않아, 자동
# 발송·테스트 발송 모두 이 도메인 수신자로만 제한한다.
ALLOWED_RECIPIENT_DOMAIN = "danbiedu.co.kr"


def is_allowed_recipient(email: str) -> bool:
    """수신자 이메일이 ALLOWED_RECIPIENT_DOMAIN 소속인지 판별한다."""
    return email.strip().lower().endswith(f"@{ALLOWED_RECIPIENT_DOMAIN}")


def has_min_deadline_gap(
    deadline_hour: int, deadline_minute: int, send_hour: int, send_minute: int,
    min_gap_minutes: int = MIN_DEADLINE_SEND_GAP_MINUTES,
) -> bool:
    """마감 시각이 발송 시각보다 최소 min_gap_minutes분 이상 앞서 있는지 판별한다."""
    deadline_total = deadline_hour * 60 + deadline_minute
    send_total = send_hour * 60 + send_minute
    return deadline_total <= send_total - min_gap_minutes


def parse_recipients(text: str) -> list[str]:
    """쉼표로 구분된 수신자 입력 문자열을 정리된 이메일 목록으로 바꾼다.
    앞뒤 공백을 지우고 빈 항목은 버린다."""
    return [part.strip() for part in text.split(",") if part.strip()]


def report_ready_by_deadline(generated_at: str, deadline_hour: int, deadline_minute: int, today: str | None = None) -> bool:
    """보고서의 generated_at('YYYY-MM-DD HH:MM:SS' 등, 공백으로 날짜·시각 구분)이
    오늘(today, 기본값 date.today()) 마감 시각(deadline_hour:deadline_minute) 이내에
    생성됐는지 판별한다.

    generated_at의 날짜가 오늘보다 이전이면 시:분이 몇 시든 항상 마감 이내로 본다 —
    예를 들어 관리자가 전날 오후에 미리 생성해둔 보고서는, 시:분만 떼어보면 마감(정오 등)을
    넘겼어도 실제로는 오늘의 마감보다 훨씬 전에 준비된 것이기 때문이다."""
    date_part, time_part = generated_at.split(" ")[:2]
    if today is None:
        today = date.today().isoformat()
    if date_part != today:
        return date_part < today
    hh, mm = (int(x) for x in time_part.split(":")[:2])
    return (hh, mm) <= (deadline_hour, deadline_minute)


def get_mail_settings(report_type: str) -> dict:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM mail_settings WHERE report_type = ?", (report_type,)
        ).fetchone()
    if row is None:
        return {"report_type": report_type, **DEFAULTS}
    return {
        "report_type": report_type,
        "enabled": bool(row["enabled"]),
        "deadline_hour": row["deadline_hour"],
        "deadline_minute": row["deadline_minute"],
        "send_hour": row["send_hour"],
        "send_minute": row["send_minute"],
        "sender_email": row["sender_email"],
        "recipients": parse_recipients(row["recipients"]),
        "send_weekday": row["send_weekday"],
    }


def reset_mail_settings(report_type: str) -> None:
    """저장된 설정 행을 지운다. 이후 get_mail_settings()는 다시 DEFAULTS를 반환한다."""
    with get_conn() as conn:
        conn.execute("DELETE FROM mail_settings WHERE report_type = ?", (report_type,))
        conn.commit()


def save_mail_settings(report_type: str, settings: dict) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO mail_settings
                (report_type, enabled, deadline_hour, deadline_minute, send_hour, send_minute, sender_email, recipients, send_weekday, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
            ON CONFLICT(report_type) DO UPDATE SET
                enabled=excluded.enabled, deadline_hour=excluded.deadline_hour, deadline_minute=excluded.deadline_minute,
                send_hour=excluded.send_hour, send_minute=excluded.send_minute, sender_email=excluded.sender_email,
                recipients=excluded.recipients, send_weekday=excluded.send_weekday, updated_at=excluded.updated_at
            """,
            (
                report_type,
                int(settings["enabled"]),
                settings["deadline_hour"],
                settings["deadline_minute"],
                settings["send_hour"],
                settings["send_minute"],
                settings["sender_email"],
                ",".join(settings["recipients"]),
                settings.get("send_weekday", "mon"),
            ),
        )
        conn.commit()
