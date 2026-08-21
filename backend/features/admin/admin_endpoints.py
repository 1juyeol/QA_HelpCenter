# -*- coding: utf-8 -*-
# 관리자 모드 게이트 API. 계정·로그인 시스템 없이 공유 암호 하나로 "관리자인지"만 확인한다.
#
# POST /api/admin/verify : 프론트에서 입력한 암호를 .env의 ADMIN_PASSCODE와 비교하고,
#   맞으면 무작위 세션 토큰을 발급한다. 실제 암호 자체는 프론트(localStorage)에 남기지 않는다 —
#   ADMIN_PASSCODE가 실제 회사 계정 비밀번호와 같을 수 있어(운영 정책), 브라우저에 평문으로
#   남기지 않기 위한 조치. 토큰은 서버 메모리에만 저장되어 서버 재시작 시 전부 무효화된다
#   (재시작 후엔 관리자 암호를 다시 입력해야 한다).
#
# require_admin(): 다른 라우터가 관리자 전용 엔드포인트를 보호할 때 쓰는 공용 의존성.
#   요청 헤더 X-Admin-Token이 발급된 토큰 목록에 있는지만 확인한다.
#   사용 예: @router.post(...) def f(_: None = Depends(require_admin)): ...
#
# 나중에 실제 ID/PW 로그인으로 바꿀 때는 이 파일의 검증 로직만 교체하면 되고, require_admin을
# 쓰는 다른 라우터들은 수정할 필요가 없다.
import os
import secrets
from dotenv import load_dotenv
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel
from core.audit_log import log_action

load_dotenv()

router = APIRouter()

_ADMIN_PASSCODE = os.environ.get("ADMIN_PASSCODE", "")
_valid_tokens: set[str] = set()


class VerifyBody(BaseModel):
    passcode: str


@router.post("/api/admin/verify")
def verify_admin(body: VerifyBody):
    if not _ADMIN_PASSCODE or body.passcode != _ADMIN_PASSCODE:
        log_action("admin_login_failed")
        return {"ok": False}
    token = secrets.token_urlsafe(24)
    _valid_tokens.add(token)
    log_action("admin_login")
    return {"ok": True, "token": token}


def require_admin(x_admin_token: str = Header(default="")) -> None:
    if x_admin_token not in _valid_tokens:
        raise HTTPException(status_code=403, detail="관리자 인증이 필요합니다")
