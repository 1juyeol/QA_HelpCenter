# -*- coding: utf-8 -*-
# Gemma 시스템 프롬프트 커스텀 값 저장·조회. core/db.py의 prompt_settings 테이블(prompt_key PK)을
# 그대로 쓴다. report_generation_settings.py와 달리 DEFAULTS를 여기 두지 않는다 — 기본값은
# 각 프롬프트가 정의된 파일의 코드 상수(예: report_utils.py의 _SYSTEM_CATEGORY)가 그대로
# "기본값"이고, 이 테이블엔 관리자가 커스텀한 것만 있으면 저장한다. get_prompt_text()가
# "커스텀 값 있으면 그거, 없으면 넘겨받은 기본값" 순서로 반환한다.
from core.db import get_conn


def get_prompt_text(prompt_key: str, default_text: str) -> str:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT prompt_text FROM prompt_settings WHERE prompt_key = ?", (prompt_key,)
        ).fetchone()
    return row["prompt_text"] if row else default_text


def is_prompt_customized(prompt_key: str) -> bool:
    with get_conn() as conn:
        row = conn.execute("SELECT 1 FROM prompt_settings WHERE prompt_key = ?", (prompt_key,)).fetchone()
    return row is not None


def save_prompt_text(prompt_key: str, prompt_text: str) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO prompt_settings (prompt_key, prompt_text, updated_at)
            VALUES (?, ?, datetime('now', 'localtime'))
            ON CONFLICT(prompt_key) DO UPDATE SET
                prompt_text=excluded.prompt_text, updated_at=excluded.updated_at
            """,
            (prompt_key, prompt_text),
        )
        conn.commit()


def reset_prompt_text(prompt_key: str) -> None:
    """커스텀 값을 지운다. 이후 get_prompt_text()는 다시 기본값(코드 상수)을 반환한다."""
    with get_conn() as conn:
        conn.execute("DELETE FROM prompt_settings WHERE prompt_key = ?", (prompt_key,))
        conn.commit()
