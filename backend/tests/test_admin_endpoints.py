# -*- coding: utf-8 -*-
# features/admin/admin_endpoints.py의 require_admin()이 X-Test-Call 요청 헤더를 보고
# core/audit_log.py의 mode=test 태깅을 실제로 트리거하는지 확인하는 테스트.
#
# 다른 테스트 파일과 달리 순수 함수 테스트가 아니라 FastAPI TestClient로 실제 HTTP 요청을
# 흉내 낸다 — require_admin이 예전에 동기(def) 함수였을 때는, FastAPI가 이 의존성과 실제
# 엔드포인트 함수를 스레드풀에서 서로 다른 컨텍스트 복사본으로 실행해서 mark_test_call()로
# 세팅한 값이 엔드포인트 쪽에 전달되지 않는 버그가 있었다. 이건 순수 함수 테스트로는 잡을 수
# 없고, 이렇게 실제 요청 경로를 태워봐야 잡힌다.
#
# require_admin()이 보호하는 진짜 라우터(prompt_settings 등)를 그대로 쓰지 않고, 이 파일
# 안에 최소한의 더미 엔드포인트(_dummy)를 하나 만들어 쓴다 — server.py의 실제 앱을 그대로
# 쓰면 Gemma·메일·스케줄러 등 이 테스트와 무관한 것들까지 초기화돼야 하기 때문이다.
#
# 실제 DB(helpdesk.db)의 audit_log 테이블에 행을 남기므로, 각 테스트가 끝나면 자기가 남긴
# 행만 id로 정확히 지워서 DB를 원상 복구한다.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from core.audit_log import log_action
from core.db import get_conn
from features.admin.admin_endpoints import _valid_tokens, require_admin

_TEST_TOKEN = "test-token-for-admin-endpoints-suite"
_DUMMY_ACTION = "test_admin_endpoints_dummy"

app = FastAPI()


@app.post("/__test_dummy__")
def _dummy(_: None = Depends(require_admin)):
    log_action(_DUMMY_ACTION)
    return {"ok": True}


client = TestClient(app)


def _latest_dummy_row() -> dict:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, mode FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1",
            (_DUMMY_ACTION,),
        ).fetchone()
    return dict(row)


def _delete_row(row_id: int) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM audit_log WHERE id = ?", (row_id,))
        conn.commit()


class TestRequireAdminTestCallTagging:
    def setup_method(self):
        _valid_tokens.add(_TEST_TOKEN)

    def teardown_method(self):
        _valid_tokens.discard(_TEST_TOKEN)

    def test_no_token_is_rejected(self):
        res = client.post("/__test_dummy__")
        assert res.status_code == 403

    def test_without_test_header_logs_as_manual(self):
        res = client.post("/__test_dummy__", headers={"X-Admin-Token": _TEST_TOKEN})
        assert res.status_code == 200
        row = _latest_dummy_row()
        assert row["mode"] == "manual"
        _delete_row(row["id"])

    def test_with_test_header_logs_as_test(self):
        res = client.post(
            "/__test_dummy__",
            headers={"X-Admin-Token": _TEST_TOKEN, "X-Test-Call": "true"},
        )
        assert res.status_code == 200
        row = _latest_dummy_row()
        assert row["mode"] == "test"
        _delete_row(row["id"])
