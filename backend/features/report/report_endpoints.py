# -*- coding: utf-8 -*-
# 보고서 API 라우터. 일별·주간 보고서 조회/생성 엔드포인트를 제공한다.
#
# GET  /api/report/daily?date=YYYY-MM-DD                     : 저장된 일별 보고서 반환. 없으면 404.
# POST /api/report/daily/generate-stats?date=YYYY-MM-DD      : 통계만 생성 (Gemma 없음, 1단계).
# POST /api/report/daily/analyze-category?date=&main=        : 특정 대분류 Gemma 분석 후 DB 저장.
# POST /api/report/daily/analyze-peak?date=                  : 피크타임 최다 버킷 Gemma 분석 후 DB 저장.
# POST /api/report/daily/generate-complete?date=&failed=      : 수동 생성 완료 요약 로그 한 줄 (프론트가 순차 호출 끝나고 호출).
# POST /api/report/daily/retry-failed?date=                   : 저장된 보고서에서 gemma_error 남은 항목만 즉시 재시도.
# GET  /api/report/weekly?week_start=YYYY-MM-DD              : 저장된 주간 보고서 반환. 없으면 404.
# POST /api/report/weekly/generate-stats?week_start=YYYY-MM-DD : 통계만 생성 (1단계).
# POST /api/report/weekly/generate?week_start=YYYY-MM-DD     : 통계 + AI 분석 전체 생성 (2단계).
# GET  /api/report/weekly/memos?week_start=&main=&page=      : 카테고리별 리스크 메모 20개씩 페이지네이션.
#
# week_start는 반드시 월요일 날짜(ISO 형식)여야 한다.
# generate-stats → generate 순서로 호출해 차트를 먼저 렌더링하고 AI 분석을 나중에 채운다.

from fastapi import APIRouter, HTTPException, Query
from features.report.report_daily import (
    generate_report_stats, get_report, analyze_single_category, analyze_peak_bucket,
    has_gemma_failures, retry_failed_analyses,
)
from features.report.report_weekly import (
    generate_weekly_report, generate_weekly_report_stats,
    get_weekly_report, get_latest_weekly_report, get_weekly_risk_memos,
    analyze_weekly_category, analyze_weekly_summary,
)
from core.audit_log import log_action

router = APIRouter()


def _gemma_detail(base: str, result: dict) -> str:
    """analyze-category/analyze-peak 결과의 gemma_error·insufficient_data를 감사 로그
    detail 문자열에 반영한다. 실패해도 print()로만 사라지지 않고 여기 남는다."""
    err = result.get("gemma_error")
    if err:
        return f"{base}, status=failed, error={err}"
    if result.get("insufficient_data"):
        return f"{base}, status=insufficient_data"
    return f"{base}, status=success"


@router.get("/api/report/daily")
def get_daily_report(date: str = Query(..., description="YYYY-MM-DD")):
    report = get_report(date)
    if report is None:
        raise HTTPException(status_code=404, detail="보고서 없음")
    return report


@router.post("/api/report/daily/generate-stats")
async def generate_daily_report_stats(date: str = Query(..., description="YYYY-MM-DD")):
    result = await generate_report_stats(date)
    log_action("daily_report_generate_stats", f"date={date}")
    return result


@router.post("/api/report/daily/analyze-category")
async def analyze_daily_category(
    date: str = Query(..., description="YYYY-MM-DD"),
    main: str = Query(..., description="대분류 이름 (예: 미납·결제)"),
):
    result = await analyze_single_category(date, main)
    log_action("daily_report_analyze_category", _gemma_detail(f"date={date}, main={main}", result))
    return result


@router.post("/api/report/daily/analyze-peak")
async def analyze_daily_peak(date: str = Query(..., description="YYYY-MM-DD")):
    result = await analyze_peak_bucket(date)
    log_action("daily_report_analyze_peak", _gemma_detail(f"date={date}", result))
    return result


@router.post("/api/report/daily/generate-complete")
def daily_report_generate_complete(
    date: str = Query(..., description="YYYY-MM-DD"),
    failed: str = Query("", description="쉼표구분 실패한 카테고리/구간 이름, 전부 성공했으면 빈 문자열"),
):
    """프론트의 '보고서 생성' 버튼이 통계·카테고리별·피크타임 순차 호출을 다 끝낸 뒤 한 번 호출한다.
    자동 생성(daily_report_auto_generate)과 동일한 형태로 감사 로그에 완료 요약 한 줄을 남긴다 —
    스텝별 로그만 있으면 "이 생성이 끝났다"는 게 한눈에 안 보이기 때문."""
    detail = f"date={date}"
    if failed:
        detail += f", gemma_failed={failed}"
    log_action("daily_report_manual_generate", detail)
    return {"status": "ok"}


@router.post("/api/report/daily/retry-failed")
async def retry_daily_report_failed(date: str = Query(..., description="YYYY-MM-DD")):
    """저장된 보고서에서 gemma_error가 남은 항목(카테고리·피크타임·이상시간대)만 즉시 재시도한다.
    자동 생성(scheduler.py)은 5분 간격으로 이걸 최대 2번 부르고, 사람이 기다리는 수동 생성은
    화면에서 한 번 더 이걸 즉시(대기 없이) 불러 실패한 것만 다시 채운다."""
    content = get_report(date)
    if content is None:
        raise HTTPException(status_code=404, detail="보고서 없음")
    if not has_gemma_failures(content):
        return content
    content = await retry_failed_analyses(date, content)

    failed = [r["main"] for r in content.get("risk_rows", []) if r.get("gemma_error")]
    if content.get("peak_bucket") and content["peak_bucket"].get("gemma_error"):
        failed.append("피크타임")
    if content.get("anomaly_bucket") and content["anomaly_bucket"].get("gemma_error"):
        failed.append("이상시간대")
    detail = f"date={date}"
    if failed:
        detail += f", gemma_failed={','.join(failed)}"
    log_action("daily_report_retry_failed", detail)
    return content


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
async def generate_weekly_report_stats_endpoint(week_start: str = Query(..., description="YYYY-MM-DD (월요일)")):
    result = await generate_weekly_report_stats(week_start)
    log_action("weekly_report_generate_stats", f"week_start={week_start}")
    return result


@router.post("/api/report/weekly/generate")
async def generate_weekly_report_endpoint(week_start: str = Query(..., description="YYYY-MM-DD (월요일)")):
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
):
    result = await analyze_weekly_category(week_start, main)
    log_action("weekly_report_analyze_category", _gemma_detail(f"week_start={week_start}, main={main}", result))
    return result


@router.post("/api/report/weekly/analyze-summary")
async def analyze_weekly_summary_endpoint(week_start: str = Query(..., description="YYYY-MM-DD (월요일)")):
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
