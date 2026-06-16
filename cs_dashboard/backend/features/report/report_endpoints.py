# -*- coding: utf-8 -*-
# 일별 보고서 API 라우터.
# GET  /api/report/daily?date=YYYY-MM-DD  : 저장된 보고서 반환. 없으면 404.
# POST /api/report/daily/generate?date=YYYY-MM-DD : 강제 재생성 (Ollama 재호출).
# 보고서 생성은 시간이 걸리므로(Ollama 2회 호출) POST는 완료까지 대기한다.

from fastapi import APIRouter, HTTPException, Query
from features.report.report_client import generate_report, get_report

router = APIRouter()


@router.get("/api/report/daily")
def get_daily_report(date: str = Query(..., description="YYYY-MM-DD")):
    report = get_report(date)
    if report is None:
        raise HTTPException(status_code=404, detail="보고서 없음")
    return report


@router.post("/api/report/daily/generate")
async def generate_daily_report(date: str = Query(..., description="YYYY-MM-DD")):
    return await generate_report(date)
