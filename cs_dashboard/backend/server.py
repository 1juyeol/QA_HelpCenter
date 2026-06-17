# FastAPI 애플리케이션 진입점. 비즈니스 로직은 없으며 '배선' 역할만 담당한다.
# 하는 일: CORS 미들웨어 등록 → features/ 하위 5개 라우터(stats·issues·insights·collection·jira) 연결 →
# 서버 시작 시 자격증명 입력·DB 초기화·스케줄러 기동·당일 데이터 수집·인사이트 캐시 초기화 →
# /assets 정적 파일 서빙 + 나머지 모든 경로에 React SPA의 index.html 반환(브라우저 새로고침 대응).
import asyncio
from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from core.db import init_db
from features.collection.scheduler import start_scheduler, collect_today, prompt_credentials, COLLECTION_ENABLED
from features.insights.insights_cache import _init_insights_cache
from features.stats.stats_endpoints import router as stats_router
from features.issues.issues_endpoints import router as issues_router
from features.insights.insights_endpoints import router as insights_router
from features.collection.collection_endpoints import router as collection_router
from features.jira.jira_endpoints import router as jira_router
from features.report.report_endpoints import router as report_router
from features.report.settings_endpoints import router as settings_router


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


@app.on_event("startup")
async def startup():
    if COLLECTION_ENABLED:
        prompt_credentials()
    init_db()
    start_scheduler()
    if COLLECTION_ENABLED:
        asyncio.create_task(collect_today())
    asyncio.create_task(_init_insights_cache())


_dist = Path(__file__).parent.parent / "frontend" / "dist"
app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

@app.get("/{full_path:path}", include_in_schema=False)
async def spa_fallback(full_path: str):
    return FileResponse(_dist / "index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
