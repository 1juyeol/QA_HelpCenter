# -*- coding: utf-8 -*-
# Playwright로 헤드리스 크로미움을 띄워 일별/주간 보고서 페이지를 스크린샷으로 캡쳐한다.
# 이 페이지들은 React SPA라 HTML만으로는 내용이 비어있고, 실제 브라우저가 JS를 실행해야 화면이
# 완성된다 — 그래서 실제 브라우저를 띄우는 방식(headless browser)이 필요하다.
#
# _INTERNAL_FRONTEND_URL: 도커 컴포즈 내부망 서비스명이다. 이 컨테이너(backend) 안에서는
# 호스트에 노출된 포트(예: localhost:8092)가 아니라 frontend 컨테이너의 서비스명으로 접근해야
# 한다 (nginx.conf가 backend를 가리킬 때 "http://backend:8000"을 쓰는 것과 같은 원리).
# 메일 본문에 넣는 "보고서 링크"(수신자가 클릭하는 것)는 이것과 다른, 실제로 외부에서 접근
# 가능한 주소(REPORT_PUBLIC_BASE_URL)를 daily_report_mailer.py/weekly_report_mailer.py가
# 별도로 쓴다.
import os
from playwright.async_api import async_playwright

_INTERNAL_FRONTEND_URL = os.environ.get("REPORT_INTERNAL_BASE_URL", "http://frontend")
_LOADED_MARKER_TEXT = "text=총 상담"

# report_type별 URL 경로·쿼리 파라미터명·캡쳐 대상 id. DailyReport.tsx/WeeklyReport.tsx
# 각각의 루트 div에 이 id를 붙여뒀다 (사이드바·헤더 없이 본문 영역만 캡쳐하기 위함).
_PAGE_CONFIG = {
    "daily": {"path": "/report/daily", "param": "date", "selector": "#daily-report-capture-root"},
    "weekly": {"path": "/report/weekly", "param": "week_start", "selector": "#weekly-report-capture-root"},
}


async def capture_report_screenshot(report_type: str, date_str: str) -> bytes:
    """report_type('daily'|'weekly')의 date_str(일별: YYYY-MM-DD, 주간: 그 주 월요일 날짜)
    보고서 페이지를 렌더링해서 본문 영역만 PNG로 캡쳐한다. 보고서가 로딩 중일 수 있어
    "총 상담" 텍스트(로딩 완료 후에만 나타남)가 뜰 때까지 기다린다."""
    cfg = _PAGE_CONFIG[report_type]
    url = f"{_INTERNAL_FRONTEND_URL}{cfg['path']}?{cfg['param']}={date_str}"
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1280, "height": 800})
        try:
            await page.goto(url, timeout=30_000)
            await page.wait_for_selector(_LOADED_MARKER_TEXT, timeout=30_000)
            element = page.locator(cfg["selector"])
            return await element.screenshot(type="png")
        finally:
            await browser.close()
