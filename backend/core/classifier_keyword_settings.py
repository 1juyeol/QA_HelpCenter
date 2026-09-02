# -*- coding: utf-8 -*-
# classifier.py의 RULES 키워드 중 관리자가 비활성화한 것을 core/db.py의
# classifier_disabled_keywords 테이블(sub, keyword 복합 PK)에 기록·조회한다.
# 실제로 RULES에서 키워드를 빼는 동작은 features/issues/classifier.py의
# apply_disabled_keywords()가 담당한다 — 이 파일은 순수 저장소 역할만 한다.
from core.db import get_conn


def get_disabled_keywords() -> set[tuple[str, str]]:
    with get_conn() as conn:
        rows = conn.execute("SELECT sub, keyword FROM classifier_disabled_keywords").fetchall()
    return {(r["sub"], r["keyword"]) for r in rows}


def disable_keyword(sub: str, keyword: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO classifier_disabled_keywords (sub, keyword) VALUES (?, ?)",
            (sub, keyword),
        )
        conn.commit()
