# -*- coding: utf-8 -*-
# 관리자 제어 액션·보고서 생성 이력을 기록하는 감사 로그.
# log_action(action, detail, mode)을 호출한 곳마다 audit_log 테이블에 한 줄씩 남는다.
#   mode="manual" : 사람이 버튼 눌러서 실행 (기본값)
#   mode="auto"   : 스케줄러가 자동으로 실행 (호출부에서 명시적으로 mode="auto"를 넘겨야 함)
# 계정 시스템이 없어 "누가" 했는지는 남기지 않고 "언제·무엇을·수동인지 자동인지"만 기록한다.
# 조회는 features/admin/audit_endpoints.py의 GET /api/audit/log(관리자 전용)가 담당하고,
# 프론트(pages/admin/AuditLog.tsx)에서 mode·action을 기준으로 드롭다운 필터링한다.
from core.db import get_conn


def log_action(action: str, detail: str = "", mode: str = "manual") -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO audit_log (action, detail, mode) VALUES (?, ?, ?)",
            (action, detail, mode),
        )
        conn.commit()


def list_audit_log(limit: int = 200) -> list:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]
