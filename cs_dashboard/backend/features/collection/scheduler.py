# APScheduler 기반 자동 수집·보고서 스케줄러. 서버 시작 시 start_scheduler()를 한 번 호출한다.
#
# ★ 스케줄 약속은 _register_jobs()에만 등록한다. 시간 변경·신규 작업 추가 시 그 함수만 수정.
#
# 핸들러 목록 (실제 로직):
#   _generate_yesterday_report() : 전날 일별 보고서 자동 생성
#   _generate_last_week_report() : 직전 주 주간 보고서 자동 생성
#   collect_today()              : Help-Desk 증분 수집 + 자정 보정·캐시 갱신
#
# 자격증명(_username, _password)은 서버 시작 시 prompt_credentials()로 입력받아 전역 변수에 보관한다.
# _wings_token: Wings(Zammad) API 토큰. 인사이트 캐시 갱신 시 티켓 상태를 실시간으로 조회하는 데 사용한다.
# collect_date()는 성공·실패 모두 collection_log 테이블에 기록해 수집 이력을 추적한다.
import asyncio
import getpass
from datetime import date, datetime, timedelta
from apscheduler.schedulers.asyncio import AsyncIOScheduler
import httpx
import pytz

from features.collection.helpdesk_client import HelpdeskClient
from core.db import get_conn
from features.issues.classifier import classify
from features.insights.insight_aggregations import compute_wings_tickets, compute_repeat_parents
from features.insights.insights_cache import _save_insights_cache

KST = pytz.timezone("Asia/Seoul")

# 외부 API 호출 전면 중단 스위치 (2026-06, 승인 전까지 OFF).
# False면 help-desk 수집·Wings 상태 조회를 일절 하지 않는다. 승인 후 True로 바꾸면 재개된다.
COLLECTION_ENABLED = False

_username: str = ""
_password: str = ""
_wings_token: str = ""
# 로그인 세션을 재사용하기 위한 공유 클라이언트. 매 수집마다 새로 로그인하지 않고
# 이 인스턴스를 계속 쓰다가, 인증 만료(401/403)가 감지될 때만 _relogin()으로 교체한다.
_client = None

# state_id → 한국어 상태명 (Wings/Zammad 기준)
_WINGS_STATE = {1: "신규", 2: "진행 중", 4: "해결", 5: "merged", 7: "요청취소", 8: "결과 확인 중"}


def prompt_credentials():
    global _username, _password, _wings_token
    print("\nhelp-desk 로그인")
    _username = input("  아이디: ")
    _password = getpass.getpass("  비밀번호: ")
    _wings_token = input("  Wings API 토큰 (없으면 엔터): ").strip()
    print()


async def _fetch_wings_states(ticket_ids: list) -> dict:
    """Wings API로 티켓 상태를 비동기 병렬 조회한다. 토큰이 없으면 빈 dict 반환."""
    if not COLLECTION_ENABLED or not _wings_token:
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


async def collect_date(target: date, incremental: bool = True):
    if not COLLECTION_ENABLED:
        return
    status = "success"
    message = ""
    count = 0
    try:
        client = await _get_client()
        # 증분 모드: 이미 DB에 있는 ID는 건너뛰고 신규분만 수집 (페이지 호출 대폭 감소).
        # incremental=False는 그날 전체를 재조회해 사후 수정분까지 보정한다(자정 보정용).
        known_ids = None
        if incremental:
            with get_conn() as conn:
                known_ids = {r[0] for r in conn.execute("SELECT id FROM issues").fetchall()}
        try:
            issues = await client.fetch_issues(target, known_ids=known_ids)
        except httpx.HTTPStatusError as e:
            # 세션 만료로 추정되면 1회만 재로그인 후 재시도
            if e.response.status_code in (401, 403):
                client = await _relogin()
                issues = await client.fetch_issues(target, known_ids=known_ids)
            else:
                raise
        count = len(issues)
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
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO collection_log (date_target, count_fetched, status, message) VALUES (?, ?, ?, ?)",
                (str(target), count, status, message),
            )
            conn.commit()

    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now}] [{target}] collected {count} issues - {status}" + (f": {message}" if message else ""))


async def collect_today():
    today = date.today()
    await collect_date(today)

    # 자정(00:00)에는 어제치를 전량 재조회(incremental=False)해 사후 수정분까지 보정 후 캐시 갱신
    if datetime.now(KST).hour == 0:
        yesterday = today - timedelta(days=1)
        await collect_date(yesterday, incremental=False)
        await update_insights_cache()


async def update_insights_cache():
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
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now}] insights cache updated")


async def _generate_yesterday_report():
    """전날 일별 보고서를 자동 생성한다. COLLECTION_ENABLED 무관하게 실행."""
    from features.report.report_daily import generate_report
    yesterday = str(date.today() - timedelta(days=1))
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    try:
        await generate_report(yesterday)
        print(f"[{now}] 일별 보고서 생성 완료: {yesterday}")
    except Exception as e:
        print(f"[{now}] 일별 보고서 생성 실패: {e}")


async def _generate_last_week_report():
    """직전 주 월요일 날짜를 계산해 주간 보고서를 자동 생성한다. COLLECTION_ENABLED 무관하게 실행."""
    from features.report.report_weekly import generate_weekly_report
    today = date.today()
    last_monday = str(today - timedelta(days=today.weekday() + 7))
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    try:
        await generate_weekly_report(last_monday)
        print(f"[{now}] 주간 보고서 생성 완료: {last_monday}")
    except Exception as e:
        print(f"[{now}] 주간 보고서 생성 실패: {e}")


# ── 스케줄 약속 ────────────────────────────────────────────────────────────────
# 언제 무엇을 실행할지 여기서만 등록한다.
# 시간 변경·신규 작업 추가는 이 함수만 수정하면 된다.

def _register_jobs(scheduler: AsyncIOScheduler) -> None:
    # 일별 보고서: 매일 00:30 KST (전날 데이터 기준)
    scheduler.add_job(_generate_yesterday_report, "cron", hour=0, minute=30)

    # 주간 보고서: 매주 월요일 00:30 KST (직전 주 월~금 기준)
    scheduler.add_job(_generate_last_week_report, "cron", day_of_week="mon", hour=0, minute=30)

    if COLLECTION_ENABLED:
        # 업무시간 증분 수집: 09:00~20:30 30분 간격
        scheduler.add_job(collect_today, "cron", hour="9-20", minute="0,30")
        # 자정: 전날 21~24시 신규분 + 어제치 전량 보정 + 인사이트 캐시 갱신
        scheduler.add_job(collect_today, "cron", hour=0, minute=0)
    else:
        print("[scheduler] COLLECTION_ENABLED=False — 자동 수집/API 호출 비활성화됨")


# ── 스케줄러 시작 ──────────────────────────────────────────────────────────────

def start_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone=KST)
    _register_jobs(scheduler)
    scheduler.start()
    return scheduler
