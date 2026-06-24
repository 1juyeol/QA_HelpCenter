# -*- coding: utf-8 -*-
# 보고서 API 라우터. 일별·주간 보고서 조회/생성 엔드포인트를 제공한다.
#
# GET  /api/report/daily?date=YYYY-MM-DD                     : 저장된 일별 보고서 반환. 없으면 404.
# POST /api/report/daily/generate-stats?date=YYYY-MM-DD      : 통계만 생성 (Ollama 없음, 1단계).
# POST /api/report/daily/analyze-category?date=&main=        : 특정 대분류 Ollama 분석 후 DB 저장.
# POST /api/report/daily/analyze-peak?date=                  : 피크타임 최다 버킷 Ollama 분석 후 DB 저장.
# GET  /api/report/weekly?week_start=YYYY-MM-DD              : 저장된 주간 보고서 반환. 없으면 404.
# POST /api/report/weekly/generate-stats?week_start=YYYY-MM-DD : 통계만 생성 (1단계).
# POST /api/report/weekly/generate?week_start=YYYY-MM-DD     : 통계 + AI 분석 전체 생성 (2단계).
# GET  /api/report/weekly/memos?week_start=&main=&page=      : 카테고리별 리스크 메모 20개씩 페이지네이션.
#
# week_start는 반드시 월요일 날짜(ISO 형식)여야 한다.
# generate-stats → generate 순서로 호출해 차트를 먼저 렌더링하고 AI 분석을 나중에 채운다.

from fastapi import APIRouter, HTTPException, Query
from features.report.report_daily import generate_report_stats, get_report, analyze_single_category, analyze_peak_bucket
from features.report.report_weekly import (
    generate_weekly_report, generate_weekly_report_stats,
    get_weekly_report, get_weekly_risk_memos,
    analyze_weekly_category, analyze_weekly_summary,
)

router = APIRouter()


@router.get("/api/report/daily")
def get_daily_report(date: str = Query(..., description="YYYY-MM-DD")):
    report = get_report(date)
    if report is None:
        raise HTTPException(status_code=404, detail="보고서 없음")
    return report


@router.post("/api/report/daily/generate-stats")
async def generate_daily_report_stats(date: str = Query(..., description="YYYY-MM-DD")):
    return await generate_report_stats(date)


@router.post("/api/report/daily/analyze-category")
async def analyze_daily_category(
    date: str = Query(..., description="YYYY-MM-DD"),
    main: str = Query(..., description="대분류 이름 (예: 미납·결제)"),
):
    return await analyze_single_category(date, main)


@router.post("/api/report/daily/analyze-peak")
async def analyze_daily_peak(date: str = Query(..., description="YYYY-MM-DD")):
    return await analyze_peak_bucket(date)


@router.get("/api/report/weekly")
def get_weekly_report_endpoint(week_start: str = Query(..., description="YYYY-MM-DD (월요일)")):
    report = get_weekly_report(week_start)
    if report is None:
        raise HTTPException(status_code=404, detail="보고서 없음")
    return report


@router.post("/api/report/weekly/generate-stats")
async def generate_weekly_report_stats_endpoint(week_start: str = Query(..., description="YYYY-MM-DD (월요일)")):
    return await generate_weekly_report_stats(week_start)


@router.post("/api/report/weekly/generate")
async def generate_weekly_report_endpoint(week_start: str = Query(..., description="YYYY-MM-DD (월요일)")):
    return await generate_weekly_report(week_start)


@router.post("/api/report/weekly/analyze-category")
async def analyze_weekly_category_endpoint(
    week_start: str = Query(..., description="YYYY-MM-DD (월요일)"),
    main: str = Query(..., description="대분류 이름"),
):
    return await analyze_weekly_category(week_start, main)


@router.post("/api/report/weekly/analyze-summary")
async def analyze_weekly_summary_endpoint(week_start: str = Query(..., description="YYYY-MM-DD (월요일)")):
    return await analyze_weekly_summary(week_start)


@router.get("/api/report/weekly/memos")
def get_weekly_memos_endpoint(
    week_start: str = Query(..., description="YYYY-MM-DD (월요일)"),
    main: str = Query(..., description="대분류 이름"),
    page: int = Query(1, ge=1),
    sub: str = Query("", description="소분류 필터 (빈 문자열이면 전체)"),
):
    return get_weekly_risk_memos(week_start, main, page, sub=sub)
