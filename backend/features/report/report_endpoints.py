# -*- coding: utf-8 -*-
# 보고서 API 라우터. 일별·주간 보고서 조회/생성 엔드포인트를 제공한다.
#
# GET  /api/report/daily?date=YYYY-MM-DD                     : 저장된 일별 보고서 반환. 없으면 404.
# POST /api/report/daily/generate?date=YYYY-MM-DD            : 통계→카테고리→피크→이상시간대→재시도
#   전체를 서버 백그라운드 작업으로 시작한다("재생성" 버튼). 이미 진행 중이면 중복 시작 안 함.
#   브라우저를 새로고침해도 이 작업 자체는 서버에서 계속 진행된다 — generate-status로 확인.
# GET  /api/report/daily/generate-status?date=YYYY-MM-DD     : 지금 생성 중인지, 몇 번째 단계인지 조회.
# POST /api/report/daily/analyze-category?date=&main=        : (디버그용 개별 실행) 특정 대분류 Gemma 분석 후 DB 저장.
# POST /api/report/daily/analyze-peak?date=                  : (디버그용 개별 실행) 피크타임 최다 버킷 Gemma 분석 후 DB 저장.
# GET  /api/report/weekly?week_start=YYYY-MM-DD              : 저장된 주간 보고서 반환. 없으면 404.
# POST /api/report/weekly/generate-stats?week_start=YYYY-MM-DD : 통계만 생성 (1단계).
# POST /api/report/weekly/generate?week_start=YYYY-MM-DD     : 통계 + AI 분석 전체 생성 (2단계).
# GET  /api/report/weekly/memos?week_start=&main=&page=      : 카테고리별 리스크 메모 20개씩 페이지네이션.
#
# week_start는 반드시 월요일 날짜(ISO 형식)여야 한다.
# 주간은 아직 generate-stats → generate 2단계 방식이다(일별처럼 백그라운드+진행 상태 표시로
# 통합 안 됨 — 다음 작업으로 예정).
#
# 보고서 메일 발송 설정·수동 테스트 발송은 features/mailer/mail_endpoints.py로 분리되어 있다.
#
# 조회(GET)는 누구나 가능하지만, 생성·분석(POST)은 전부 require_admin으로 관리자 로그인이
# 필요하다 — 로그인 없이도 Gemma 호출(비용 발생)이 가능했던 걸 막기 위함.

import asyncio
from fastapi import APIRouter, Depends, HTTPException, Query
from features.report.report_daily import (
    generate_report_full, get_report, get_latest_report, analyze_single_category, analyze_peak_bucket,
)
from features.report.report_weekly import (
    generate_weekly_report, generate_weekly_report_stats,
    get_weekly_report, get_latest_weekly_report, get_weekly_risk_memos,
    analyze_weekly_category, analyze_weekly_summary,
)
from features.report.report_utils import gemma_detail as _gemma_detail
from core.audit_log import log_action
from core import report_progress
from features.admin.admin_endpoints import require_admin

router = APIRouter()


@router.get("/api/report/daily")
def get_daily_report(date: str = Query(..., description="YYYY-MM-DD")):
    report = get_report(date)
    if report is None:
        raise HTTPException(status_code=404, detail="보고서 없음")
    return report


@router.get("/api/report/daily/latest")
def get_latest_daily_report_endpoint():
    report = get_latest_report()
    if report is None:
        raise HTTPException(status_code=404, detail="보고서 없음")
    return report


@router.post("/api/report/daily/analyze-category")
async def analyze_daily_category(
    date: str = Query(..., description="YYYY-MM-DD"),
    main: str = Query(..., description="대분류 이름 (예: 미납·결제)"),
    _: None = Depends(require_admin),
):
    result = await analyze_single_category(date, main)
    log_action("daily_report_analyze_category", _gemma_detail(f"date={date}, main={main}", result))
    return result


@router.post("/api/report/daily/analyze-peak")
async def analyze_daily_peak(date: str = Query(..., description="YYYY-MM-DD"), _: None = Depends(require_admin)):
    result = await analyze_peak_bucket(date)
    log_action("daily_report_analyze_peak", _gemma_detail(f"date={date}", result))
    return result or None


@router.post("/api/report/daily/generate")
async def generate_daily_report(date: str = Query(..., description="YYYY-MM-DD"), _: None = Depends(require_admin)):
    """'재생성' 버튼 — 통계→카테고리→피크→이상시간대→실패 재시도 전체를 서버 백그라운드
    작업으로 시작한다. 이미 이 날짜로 생성이 진행 중이면 중복 시작하지 않고 그 사실만 알려준다.
    브라우저가 새로고침돼도 asyncio 태스크는 서버에서 계속 돈다 — generate-status로 진행 상태를 본다."""
    if report_progress.is_running("daily", date):
        return {"started": False, "reason": "already_running"}
    asyncio.create_task(generate_report_full(date, mode="manual"))
    return {"started": True}


@router.get("/api/report/daily/generate-status")
def get_daily_report_generate_status(date: str = Query(..., description="YYYY-MM-DD")):
    status = report_progress.get_status("daily", date)
    return status or {"running": False}


@router.get("/api/report/weekly/latest")
def get_latest_weekly_report_endpoint():
    report = get_latest_weekly_report()
    if report is None:
        raise HTTPException(status_code=404, detail="보고서 없음")
    return report


@router.get("/api/report/weekly")
def get_weekly_report_endpoint(week_start: str = Query(..., description="YYYY-MM-DD (월요일)")):
    report = get_weekly_report(week_start)
    if report is None:
        raise HTTPException(status_code=404, detail="보고서 없음")
    return report


@router.post("/api/report/weekly/generate-stats")
async def generate_weekly_report_stats_endpoint(week_start: str = Query(..., description="YYYY-MM-DD (월요일)"), _: None = Depends(require_admin)):
    result = await generate_weekly_report_stats(week_start)
    log_action("weekly_report_generate_stats", f"week_start={week_start}")
    return result


@router.post("/api/report/weekly/generate")
async def generate_weekly_report_endpoint(week_start: str = Query(..., description="YYYY-MM-DD (월요일)"), _: None = Depends(require_admin)):
    result = await generate_weekly_report(week_start)
    failed = [r["main"] for r in result.get("risk_rows", []) if r.get("gemma_error")]
    detail = f"week_start={week_start}"
    if failed:
        detail += f", gemma_failed={','.join(failed)}"
    if result.get("weekly_summary_error"):
        detail += f", summary_error={result['weekly_summary_error']}"
    log_action("weekly_report_generate", detail)
    return result


@router.post("/api/report/weekly/analyze-category")
async def analyze_weekly_category_endpoint(
    week_start: str = Query(..., description="YYYY-MM-DD (월요일)"),
    main: str = Query(..., description="대분류 이름"),
    _: None = Depends(require_admin),
):
    result = await analyze_weekly_category(week_start, main)
    log_action("weekly_report_analyze_category", _gemma_detail(f"week_start={week_start}, main={main}", result))
    return result


@router.post("/api/report/weekly/analyze-summary")
async def analyze_weekly_summary_endpoint(week_start: str = Query(..., description="YYYY-MM-DD (월요일)"), _: None = Depends(require_admin)):
    result = await analyze_weekly_summary(week_start)
    log_action("weekly_report_analyze_summary", _gemma_detail(f"week_start={week_start}", result))
    return result


@router.get("/api/report/weekly/memos")
def get_weekly_memos_endpoint(
    week_start: str = Query(..., description="YYYY-MM-DD (월요일)"),
    main: str = Query(..., description="대분류 이름"),
    page: int = Query(1, ge=1),
    sub: str = Query("", description="소분류 필터 (빈 문자열이면 전체)"),
):
    return get_weekly_risk_memos(week_start, main, page, sub=sub)
