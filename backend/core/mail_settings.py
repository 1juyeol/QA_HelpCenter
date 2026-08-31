# -*- coding: utf-8 -*-
# 일별/주간 보고서 메일링 설정(on/off, 마감시간, 발송시각, 발신자, 수신자) 저장·조회.
# core/db.py의 mail_settings 테이블(report_type='daily'|'weekly' PK)을 그대로 쓴다 —
# collection_settings.py처럼 파일이 아니라 테이블인 이유는, 값이 하나가 아니라 report_type별로
# 여러 항목(시각 4개, 발신자, 수신자 목록)이 필요해서 단일 JSON보다 테이블이 자연스럽다.
# 아직 설정한 적 없는 report_type을 조회하면 DEFAULTS로 채워 반환한다(테이블에 행이 없어도 됨).
from datetime import date

from core.db import get_conn

DEFAULTS = {
    "enabled": True,
    "deadline_hour": 11,
    "deadline_minute": 0,
    "send_hour": 11,
    "send_minute": 0,
    "sender_email": "",
    "recipients": [],
}

# 마감 시각과 발송 시각 사이에 최소한 이만큼(분)은 떨어져 있어야 한다. 너무 붙어있으면
# "마감 시각에 딱 맞춰 만들어진 보고서"를 스크린샷·발송까지 끝낼 시간이 부족해질 수 있다.
MIN_DEADLINE_SEND_GAP_MINUTES = 10


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
                (report_type, enabled, deadline_hour, deadline_minute, send_hour, send_minute, sender_email, recipients, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
            ON CONFLICT(report_type) DO UPDATE SET
                enabled=excluded.enabled, deadline_hour=excluded.deadline_hour, deadline_minute=excluded.deadline_minute,
                send_hour=excluded.send_hour, send_minute=excluded.send_minute, sender_email=excluded.sender_email,
                recipients=excluded.recipients, updated_at=excluded.updated_at
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
            ),
        )
        conn.commit()
