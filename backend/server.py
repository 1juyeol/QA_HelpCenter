# -*- coding: utf-8 -*-
# FastAPI 애플리케이션 진입점. 비즈니스 로직은 없으며 '배선' 역할만 담당한다.
# 하는 일: CORS 미들웨어 등록 → features/ 하위 11개 라우터(stats·issues·insights·collection·jira·report·settings·admin·audit·mailer·generation_settings) 연결 →
# 서버 시작 시 DB 초기화·스케줄러 기동·인사이트 캐시 초기화 → (CS 상담 수집 API는 서버
# 시작 시 호출하지 않는다 — id 커서 방식이라 다음 정기 호출 때 그대로 따라잡히므로, 잦은
# 재시작 때마다 승인된 하루 호출 횟수를 깎아먹을 이유가 없다) →
# /assets 정적 파일 서빙 + 나머지 모든 경로에 React SPA의 index.html 반환(브라우저 새로고침 대응).
import sys
# Windows 콘솔 기본 인코딩(cp949)에서는 이모지·특수문자(예: —) print 시 UnicodeEncodeError로 서버가
# 죽는다. stdout/stderr을 UTF-8로 강제해 어떤 콘솔 환경에서도 죽지 않게 한다.
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

import asyncio
from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from core.db import init_db
from core.gemma_client import log_gemma_models
from features.collection.scheduler import start_scheduler
from features.insights.insights_cache import _init_insights_cache
from features.stats.stats_endpoints import router as stats_router
from features.issues.issues_endpoints import router as issues_router
from features.insights.insights_endpoints import router as insights_router
from features.collection.collection_endpoints import router as collection_router
from features.jira.jira_endpoints import router as jira_router
from features.report.report_endpoints import router as report_router
from features.settings.settings_endpoints import router as settings_router
from features.admin.admin_endpoints import router as admin_router
from features.admin.audit_endpoints import router as audit_router
from features.mailer.mail_endpoints import router as mail_router
from features.report.generation_settings_endpoints import router as generation_settings_router
from features.report.prompt_settings_endpoints import router as prompt_settings_router


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(stats_router)
app.include_router(issues_router)
app.include_router(insights_router)
app.include_router(collection_router)
app.include_router(jira_router)
app.include_router(report_router)
app.include_router(settings_router)
app.include_router(admin_router)
app.include_router(audit_router)
app.include_router(mail_router)
app.include_router(generation_settings_router)
app.include_router(prompt_settings_router)


@app.on_event("startup")
async def startup():
    init_db()
    start_scheduler()
    asyncio.create_task(log_gemma_models())
    asyncio.create_task(_init_insights_cache())


_dist = Path(__file__).parent.parent / "frontend" / "dist"
if _dist.exists():
    # Docker 배포에서는 nginx 컨테이너가 프론트를 서빙하므로 frontend/dist가 없다 —
    # 그 경우엔 SPA 서빙을 건너뛰고 API 서버로만 동작한다.
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        return FileResponse(_dist / "index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
