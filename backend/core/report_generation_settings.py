# -*- coding: utf-8 -*-
# 일별/주간 보고서 자동 생성 설정(on/off, 생성 시각) 저장·조회.
# core/db.py의 report_generation_settings 테이블(report_type PK)을 그대로 쓴다.
# report_type은 'daily'|'weekly' 외에 'wings_refresh'|'repeat_parents_refresh'(인사이트 캐시
# 자동 갱신)도 포함한다 — on/off + 시각이라는 형태가 같아서 이 테이블을 그대로 재사용한다.
# core/mail_settings.py와 같은 구조지만, 생성은 "무언가를 기다리는" 마감 시각 개념이 없고
# (그 자체가 파이프라인의 첫 단계라서) 발신자·수신자도 없어서 on/off + 시각 하나뿐이라 더 단순하다.
# 아직 설정한 적 없는 report_type을 조회하면 DEFAULTS로 채워 반환한다(테이블에 행이 없어도 됨).
from core.db import get_conn

DEFAULTS = {
    "enabled": True,
    "generate_hour": 0,
    "generate_minute": 30,
}


def get_generation_settings(report_type: str) -> dict:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM report_generation_settings WHERE report_type = ?", (report_type,)
        ).fetchone()
    if row is None:
        return {"report_type": report_type, **DEFAULTS}
    return {
        "report_type": report_type,
        "enabled": bool(row["enabled"]),
        "generate_hour": row["generate_hour"],
        "generate_minute": row["generate_minute"],
    }


def reset_generation_settings(report_type: str) -> None:
    """저장된 설정 행을 지운다. 이후 get_generation_settings()는 다시 DEFAULTS를 반환한다."""
    with get_conn() as conn:
        conn.execute("DELETE FROM report_generation_settings WHERE report_type = ?", (report_type,))
        conn.commit()


def save_generation_settings(report_type: str, settings: dict) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO report_generation_settings
                (report_type, enabled, generate_hour, generate_minute, updated_at)
            VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
            ON CONFLICT(report_type) DO UPDATE SET
                enabled=excluded.enabled, generate_hour=excluded.generate_hour,
                generate_minute=excluded.generate_minute, updated_at=excluded.updated_at
            """,
            (
                report_type,
                int(settings["enabled"]),
                settings["generate_hour"],
                settings["generate_minute"],
            ),
        )
        conn.commit()
