# -*- coding: utf-8 -*-
# APScheduler 기반 자동 수집·보고서 스케줄러. 서버 시작 시 start_scheduler()를 한 번 호출한다.
#
# ★ 스케줄 약속은 _register_jobs()에만 등록한다. 시간 변경·신규 작업 추가 시 그 함수만 수정.
#
# 핸들러 목록 (실제 로직):
#   _generate_yesterday_report()    : 전날 일별 보고서 자동 생성
#   _generate_last_week_report()    : 직전 주 주간 보고서 자동 생성
#   _cache_keyword_trend_today()    : 오늘 keyword_trend 미리 계산해 캐시 저장 (탐지 이력 누락 방지)
#   collect_new(trigger)            : 실제 수집 로직 — 마지막 저장 id 이후 신규분을 id 커서 방식으로
#                                      가져오고, 어떤 트리거가 호출했는지(collection_log.source)를 남긴다.
#   collect_regular()                : 업무시간 정기 수집 (trigger="정기")
#   collect_morning_catchup()       : 09:00 수집(trigger="아침보정") + 인사이트 캐시 갱신
#   collect_night_catchup()         : 심야 수집 (trigger="심야보정")
#
# 수집 스펙(2026-08 최종 승인): id 커서 방식(fetch_issues_since, "마지막 id보다 큰 것만")이라
#   시간 창 개념이 없다 — 공백이 6분이었든 9시간이었든 collect_new() 하나로 전부 처리된다.
#   그래서 이전에 있던 "최근 6분/9시간 창"별 함수 3개는 이 하나로 합쳐졌고, 위 3개 래퍼는
#   trigger 라벨만 다르게 붙여 collection_log에서 호출 종류를 구분하기 위한 것이다.
#   호출 스케줄(하루 최대 146회, 5분 간격 등)은 회사가 정한 호출 빈도 제한이라 그대로 유지한다
#   (하단 _register_jobs 참고).
#
# 자격증명(_username, _password)은 .env의 HELPDESK_USERNAME/HELPDESK_PASSWORD에서 서버 시작 시 읽어온다.
#   대화형 input()이 아닌 환경변수를 쓰는 이유: Docker 컨테이너 등 사람이 지켜보지 않는 환경에서
#   자동으로 재시작될 때, 키보드 입력을 기다리며 멈추지 않고 바로 기동돼야 하기 때문.
# _wings_token: Wings(Zammad) API 토큰. 인사이트 캐시 갱신 시 티켓 상태를 실시간으로 조회하는 데 사용한다.
# collect_new()는 성공·실패 모두 collection_log 테이블에 기록해 수집 이력을 추적한다.
import asyncio
from datetime import date, datetime, timedelta
from apscheduler.schedulers.asyncio import AsyncIOScheduler
import httpx
import pytz

from features.collection.helpdesk_client import HelpdeskClient
from core.db import get_conn
from features.issues.classifier import classify
from features.insights.insight_aggregations import compute_wings_tickets, compute_repeat_parents
from features.insights.insights_cache import _save_insights_cache
from core.collection_settings import get_collection_enabled
from core.audit_log import log_action

KST = pytz.timezone("Asia/Seoul")

# 외부 API 호출 전면 스위치는 core/collection_settings.py(get_collection_enabled)가 관리한다.
# 관리자 모드에서 켜고 끌 수 있고, collection_settings.json에 저장되어 재시작해도 유지된다.
# 기본값은 False — 회사 승인 전까지는 help-desk 수집·Wings 상태 조회를 일절 하지 않는다.

import os as _os
from dotenv import load_dotenv as _load_dotenv
_load_dotenv()
_username: str = _os.environ.get("HELPDESK_USERNAME", "").strip()
_password: str = _os.environ.get("HELPDESK_PASSWORD", "").strip()
_wings_token: str = _os.environ.get("WINGS_TOKEN", "").strip()
# 로그인 세션을 재사용하기 위한 공유 클라이언트. 매 수집마다 새로 로그인하지 않고
# 이 인스턴스를 계속 쓰다가, 인증 만료(401/403)가 감지될 때만 _relogin()으로 교체한다.
_client = None

# state_id → 한국어 상태명 (Wings/Zammad 기준)
_WINGS_STATE = {1: "신규", 2: "진행 중", 4: "해결", 5: "merged", 7: "요청취소", 8: "결과 확인 중"}


async def _fetch_wings_states(ticket_ids: list) -> dict:
    """Wings API로 티켓 상태를 비동기 병렬 조회한다. 토큰이 없으면 빈 dict 반환."""
    if not _wings_token:
        return {}
    headers = {"Authorization": f"Token token={_wings_token}"}
    async with httpx.AsyncClient(timeout=10) as client:
        responses = await asyncio.gather(
            *[client.get(f"https://wings.danbiedu.co.kr/api/v1/tickets/{tid}", headers=headers)
              for tid in ticket_ids],
            return_exceptions=True,
        )
    result = {}
    for tid, resp in zip(ticket_ids, responses):
        if isinstance(resp, Exception) or resp.status_code != 200:
            result[str(tid)] = "확인불가"
        else:
            state_id = resp.json().get("state_id")
            result[str(tid)] = _WINGS_STATE.get(state_id, "알 수 없음")
    return result


async def _get_client() -> HelpdeskClient:
    """공유 로그인 세션을 반환한다. 없으면 최초 1회 로그인한다 (이후 재사용)."""
    global _client
    if _client is None:
        _client = await HelpdeskClient.login(_username, _password)
    return _client


async def _relogin() -> HelpdeskClient:
    """세션 만료(401/403) 감지 시 기존 클라이언트를 닫고 새로 로그인한다."""
    global _client
    if _client is not None:
        await _client.close()
    _client = await HelpdeskClient.login(_username, _password)
    return _client


async def collect_new(trigger: str = "수동"):
    """마지막으로 저장된 id 이후의 신규 이슈를 승인된 id 커서 방식으로 수집해 DB에 반영한다.
    trigger: 이 호출을 일으킨 주체 라벨(정기/아침보정/심야보정/서버시작/수동) — collection_log에
    남겨서 관리자 페이지에서 자동 스케줄 호출인지 수동 테스트인지 구분할 수 있게 한다.
    성공·실패 모두 collection_log에 기록한다."""
    if not get_collection_enabled():
        return
    status = "success"
    message = ""
    count = 0
    last_id = 0
    end_id = None
    try:
        with get_conn() as conn:
            row = conn.execute("SELECT MAX(id) AS max_id FROM issues").fetchone()
        last_id = row["max_id"] or 0
        end_id = last_id

        client = await _get_client()
        try:
            issues = await client.fetch_issues_since(last_id)
        except httpx.HTTPStatusError as e:
            # 세션 만료로 추정되면 1회만 재로그인 후 재시도
            if e.response.status_code in (401, 403):
                client = await _relogin()
                issues = await client.fetch_issues_since(last_id)
            else:
                raise
        count = len(issues)
        if issues:
            end_id = issues[-1]["id"]  # fetch_issues_since는 id 오름차순으로 반환
        for issue in issues:
            main, sub = classify(issue.get("call_memo", ""))
            if main is None:
                main, sub = "기타", "기타"
            issue["new_category_main"] = main
            issue["new_category_sub"] = sub
        with get_conn() as conn:
            conn.executemany(
                """
                INSERT OR REPLACE INTO issues
                    (id, created_date, complete_date, category_tag,
                     category_main, category_sub, category_full, call_memo,
                     new_category_main, new_category_sub, student_id, parent_id)
                VALUES
                    (:id, :created_date, :complete_date, :category_tag,
                     :category_main, :category_sub, :category_full, :call_memo,
                     :new_category_main, :new_category_sub, :student_id, :parent_id)
                """,
                issues,
            )
            conn.commit()
    except Exception as e:
        status = "error"
        message = str(e)
    finally:
        # 세션은 재사용하므로 매 수집마다 닫지 않는다 (만료 시 _relogin에서만 교체).
        # last_id~end_id를 같이 저장해두면, 나중에 "이 호출이 정확히 뭘 가져왔는지"를
        # issues WHERE id > last_id ORDER BY id LIMIT count_fetched 로 그대로 복원할 수 있다.
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO collection_log (date_target, count_fetched, status, message, last_id, end_id, source) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (str(date.today()), count, status, message, last_id, end_id, trigger),
            )
            conn.commit()

    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now}] [{trigger}] [id>{last_id}] collected {count} issues - {status}" + (f": {message}" if message else ""))


async def collect_regular():
    """업무시간 5분 간격 정기 수집."""
    await collect_new(trigger="정기")


async def collect_morning_catchup():
    """09:00 수집: collect_new()와 동일하게 신규분을 수집하고, 추가로 인사이트 캐시를 갱신한다."""
    await collect_new(trigger="아침보정")
    await update_insights_cache(mode="auto")


async def collect_night_catchup():
    """심야(00:00) 수집."""
    await collect_new(trigger="심야보정")


async def update_insights_cache(mode: str = "manual"):
    """수동(/api/insights/refresh)·자동(collect_morning_catchup) 양쪽에서 호출되는 공용 함수라
    감사 로그 기록도 여기 한 곳에서만 남긴다 (호출부마다 따로 남기면 중복된다).
    mode는 호출부가 명시해서 감사 로그의 수동/자동 구분에 쓰인다."""
    end = str(date.today())
    start = str(date.today() - timedelta(days=30))
    wings = compute_wings_tickets(start, end)
    parents = compute_repeat_parents(start, end)
    if wings:
        states = await _fetch_wings_states([t["ticket_id"] for t in wings])
        for t in wings:
            t["state"] = states.get(str(t["ticket_id"]), "확인불가")
        wings = [t for t in wings if t["state"] not in ("해결", "요청취소", "merged")]
    _save_insights_cache(wings, parents)
    log_action("insights_refresh", mode=mode)
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now}] insights cache updated")


async def _cache_keyword_trend_today():
    """오늘 날짜의 keyword_trend를 미리 계산해 캐시에 저장한다. COLLECTION_ENABLED 무관하게 실행."""
    from features.stats.stats_endpoints import stats_keyword_trend
    today = str(date.today())
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    try:
        await asyncio.to_thread(stats_keyword_trend, today)
        log_action("keyword_trend_cache", f"date={today}", mode="auto")
        print(f"[{now}] keyword_trend 캐시 저장 완료: {today}")
    except Exception as e:
        log_action("keyword_trend_cache_failed", f"date={today}, error={e}", mode="auto")
        print(f"[{now}] keyword_trend 캐시 저장 실패: {e}")


async def _generate_yesterday_report():
    """전날 일별 보고서를 자동 생성한다. COLLECTION_ENABLED 무관하게 실행.
    이미 완전히 성공한 보고서가 있으면(예: 낮에 수동으로 미리 생성해둔 경우) 통째로 다시
    만드는 낭비를 피하려고 건너뛴다 — 이건 "매일 밤 무조건 도는 배치"라는 트리거 특성상 필요한
    판단이라 여기(스케줄러)에 남긴다. 그 외의 실제 생성 로직(카테고리→피크→이상시간대→재시도)은
    수동 '재생성' 버튼과 완전히 동일한 generate_report_full()을 그대로 쓴다 — 트리거만 다르고
    로직 자체가 갈라질 이유가 없다 (예전엔 자동만 이상시간대 분석·5분 간격 재시도가 있는 등
    따로 구현되어 있어서 계속 어긋났었다)."""
    from features.report.report_daily import generate_report_full, get_report, has_gemma_failures
    yesterday = str(date.today() - timedelta(days=1))
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    existing = get_report(yesterday)
    if existing and not has_gemma_failures(existing):
        log_action("daily_report_auto_generate_skipped", f"date={yesterday}, reason=이미 완성된 보고서 있음", mode="auto")
        print(f"[{now}] 일별 보고서 자동 생성 스킵 (이미 완성됨): {yesterday}")
        return
    try:
        await generate_report_full(yesterday, mode="auto")
        print(f"[{now}] 일별 보고서 생성 완료: {yesterday}")
    except Exception as e:
        log_action("daily_report_auto_generate_failed", f"date={yesterday}, error={e}", mode="auto")
        print(f"[{now}] 일별 보고서 생성 실패: {e}")


async def _generate_last_week_report():
    """직전 주 월요일 날짜를 계산해 주간 보고서를 자동 생성한다. COLLECTION_ENABLED 무관하게 실행.
    일별과 동일하게 카테고리별 부분 실패를 반환값에서 확인해 감사 로그에 남긴다."""
    from features.report.report_weekly import generate_weekly_report
    today = date.today()
    last_monday = str(today - timedelta(days=today.weekday() + 7))
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    try:
        content = await generate_weekly_report(last_monday)
        failed = [r["main"] for r in content.get("risk_rows", []) if r.get("gemma_error")]
        detail = f"week_start={last_monday}"
        if failed:
            detail += f", gemma_failed={','.join(failed)}"
        if content.get("weekly_summary_error"):
            detail += f", summary_error={content['weekly_summary_error']}"
        log_action("weekly_report_auto_generate", detail, mode="auto")
        print(f"[{now}] 주간 보고서 생성 완료: {last_monday}" + (f" (일부 실패: {failed})" if failed else ""))
    except Exception as e:
        log_action("weekly_report_auto_generate_failed", f"week_start={last_monday}, error={e}", mode="auto")
        print(f"[{now}] 주간 보고서 생성 실패: {e}")


# ── 스케줄 약속 ────────────────────────────────────────────────────────────────
# 언제 무엇을 실행할지 여기서만 등록한다.
# 시간 변경·신규 작업 추가는 이 함수만 수정하면 된다.

def _register_jobs(scheduler: AsyncIOScheduler) -> None:
    # 일별 보고서: 매일 00:30 KST (전날 데이터 기준)
    scheduler.add_job(_generate_yesterday_report, "cron", hour=0, minute=30)

    # keyword_trend 캐시: 매일 08:00 KST (탐지 이력 누락 방지 — 접속 여부와 무관하게 저장)
    scheduler.add_job(_cache_keyword_trend_today, "cron", hour=8, minute=0)

    # 주간 보고서: 매주 월요일 00:30 KST (직전 주 월~금 기준)
    scheduler.add_job(_generate_last_week_report, "cron", day_of_week="mon", hour=0, minute=30)

    # 승인된 호출 빈도(하루 최대 146회). 트리거는 항상 등록해두고, 실제 실행 여부는
    # collect_new()가 매번 get_collection_enabled()를 확인해 판단한다 — 관리자 모드에서
    # 서버 재시작 없이 켜고 끄면 바로 다음 트리거부터 반영되게 하기 위함.
    # id 커서 방식이라 내부적으로는 다 같은 collect_new()를 부르지만, trigger 라벨로
    # collection_log에 "정기/아침보정/심야보정"을 구분해 남긴다 (관리자 페이지 로그 참고).
    #   09:00        : 수집 + 인사이트 캐시 갱신 — collect_morning_catchup
    #   09:05~20:55  : 업무시간 정기 수집, 5분 간격 — collect_regular (11+132=143회)
    #   21:00        : 정기 수집 마지막 1회 — collect_regular
    #   00:00        : 심야 수집 1회 — collect_night_catchup
    scheduler.add_job(collect_morning_catchup, "cron", hour=9, minute=0)
    scheduler.add_job(collect_regular, "cron", hour=9, minute="5-55/5")
    scheduler.add_job(collect_regular, "cron", hour="10-20", minute="*/5")
    scheduler.add_job(collect_regular, "cron", hour=21, minute=0)
    scheduler.add_job(collect_night_catchup, "cron", hour=0, minute=0)

    status = "ON" if get_collection_enabled() else "OFF"
    print(f"[scheduler] CS 상담 수집 자동 트리거 등록 완료 (현재 상태: {status})")


# ── 스케줄러 시작 ──────────────────────────────────────────────────────────────

def start_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone=KST)
    _register_jobs(scheduler)
    scheduler.start()
    return scheduler
