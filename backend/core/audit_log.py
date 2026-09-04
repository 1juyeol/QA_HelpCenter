# -*- coding: utf-8 -*-
# 관리자 제어 액션·보고서 생성 이력을 기록하는 감사 로그.
# log_action(action, detail, mode)을 호출한 곳마다 audit_log 테이블에 한 줄씩 남는다.
#   mode="manual" : 사람이 버튼 눌러서 실행 (기본값)
#   mode="auto"   : 스케줄러가 자동으로 실행 (호출부에서 명시적으로 mode="auto"를 넘겨야 함)
#   mode="test"   : 개발자가 기능 검증차 API를 직접 호출한 경우. 호출부가 따로 mode를 신경 쓸
#     필요 없이, 요청 처리 중 mark_test_call(True)이 한 번 불리면 그 요청 동안 "manual"로
#     남으려던 로그가 전부 자동으로 "test"로 바뀐다 — features/admin/admin_endpoints.py의
#     require_admin()/verify_admin()이 X-Test-Call 요청 헤더를 보고 표시해준다.
# 계정 시스템이 없어 "누가" 했는지는 남기지 않고 "언제·무엇을·수동인지 자동인지 테스트인지"만 기록한다.
# 조회는 features/admin/audit_endpoints.py의 GET /api/audit/log(관리자 전용)가 담당하고,
# 프론트(pages/admin/AuditLog.tsx)에서 mode·action을 기준으로 드롭다운 필터링한다.
from contextvars import ContextVar

from core.db import get_conn

# 요청(비동기 컨텍스트) 단위로만 유효하다 — contextvars라서 동시에 처리되는 다른 요청에는
# 영향을 주지 않는다. asyncio.create_task로 백그라운드로 넘어간 작업도 생성 시점의 컨텍스트를
# 그대로 이어받으므로("재생성" 같은 백그라운드 생성 작업도) 값이 유지된다.
_test_call: ContextVar[bool] = ContextVar("_test_call", default=False)


def mark_test_call(is_test: bool) -> None:
    _test_call.set(is_test)


def log_action(action: str, detail: str = "", mode: str = "manual") -> None:
    if mode == "manual" and _test_call.get():
        mode = "test"
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO audit_log (action, detail, mode) VALUES (?, ?, ?)",
            (action, detail, mode),
        )
        conn.commit()


def was_already_logged(action: str, detail: str) -> bool:
    """action+detail이 정확히 일치하는 로그가 이미 있는지 확인한다. 일별·주간 메일러가 자동
    발송 직전에 "이 날짜/이 주는 이미 status=sent로 남아있지 않은가"를 확인하는 용도 —
    메일링을 꺼둔 채로 발송 시각을 넘겼다가 다시 켜서 저장할 때 즉시 재시도 발송하는 기능이
    생기면서, 같은 보고서를 두 번 보내는 걸 막기 위해 필요해졌다."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM audit_log WHERE action = ? AND detail = ? LIMIT 1",
            (action, detail),
        ).fetchone()
    return row is not None


def list_audit_log(limit: int = 200) -> list:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]
