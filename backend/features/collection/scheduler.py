# -*- coding: utf-8 -*-
# APScheduler 기반 자동 수집·보고서 스케줄러. 서버 시작 시 start_scheduler()를 한 번 호출한다.
#
# ★ 스케줄 약속은 _register_jobs()에만 등록한다. 시간 변경·신규 작업 추가 시 그 함수만 수정.
#
# 핸들러 목록 (실제 로직):
#   _generate_yesterday_report()    : 전날 일별 보고서 자동 생성 (생성 시각은 관리자 페이지
#                                      "자동화 관리"에서 설정, core/report_generation_settings.py)
#   _send_daily_report_mail()       : 직전 영업일 일별 보고서 메일 발송 (features/mailer/)
#   _send_weekly_report_mail()      : 직전 주 주간 보고서 메일 발송 (features/mailer/)
#   _generate_last_week_report()    : 직전 주 주간 보고서 자동 생성 (매주 월요일, 생성 시각은 위와 동일하게 설정)
#   reschedule_mail_job(report_type)      : 메일링 설정 저장 직후 해당 발송 시각을 즉시 재등록
#   reschedule_generation_job(report_type): 생성 설정 저장 직후 해당 생성 시각을 즉시 재등록
#   collect_new(trigger)            : 실제 수집 로직 — 마지막 저장 id 이후 신규분을 id 커서 방식으로
#                                      가져오고, 어떤 트리거가 호출했는지(collection_log.source)를 남긴다.
#   collect_regular()                : 업무시간 정기 수집 (trigger="정기")
#   collect_morning_catchup()       : 09:00 수집(trigger="아침보정") + 인사이트 캐시 갱신
#   collect_night_catchup()         : 심야 수집 (trigger="심야보정")
#
# 서버 시작 시에는 수집 API를 호출하지 않는다 — id 커서 방식이라 시간 창 개념이 없어서
# 다음 정기 호출(최대 5분 뒤) 때 놓친 것 없이 그대로 따라잡는다. 예전엔 서버 시작마다
# "서버시작" 트리거로 즉시 1회 수집했는데, 개발 중 서버가 짧은 간격으로 반복 재시작될 때마다
# 호출이 나가서 승인된 하루 호출 횟수를 불필요하게 깎아먹는 문제가 있어 아예 없앴다.
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
import json
from datetime import date, datetime, timedelta
from apscheduler.schedulers.asyncio import AsyncIOScheduler
import httpx
import pytz

from features.collection.helpdesk_client import HelpdeskClient
from core.db import get_conn
from features.issues.classifier import classify
from features.insights.insight_aggregations import compute_wings_tickets, compute_repeat_parents, compute_wings_delay_counts
from features.insights.insights_cache import _save_wings_cache, _save_repeat_parents_cache, _read_cache, _save_wings_delay_snapshot
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


_WINGS_STATE_CONCURRENCY = 20  # 티켓이 많아져도(전체 티켓 캡 제거) Wings API를 한꺼번에 몰아치지 않도록 제한


async def _fetch_wings_states(ticket_ids: list) -> dict:
    """Wings API로 티켓 상태를 비동기 병렬 조회한다. 토큰이 없으면 빈 dict 반환.
    동시 요청 수를 _WINGS_STATE_CONCURRENCY로 제한한다 — 티켓 캡을 없앤 뒤로는 한 번에
    수백~수천 건을 조회해야 할 수 있어, 제한 없이 다 쏘면 Wings 서버가 레이트리밋을 걸거나
    타임아웃이 늘어 "확인불가"(=미해결 취급) 오탐이 늘어날 수 있다."""
    if not _wings_token:
        return {}
    headers = {"Authorization": f"Token token={_wings_token}"}
    semaphore = asyncio.Semaphore(_WINGS_STATE_CONCURRENCY)

    async def _fetch_one(client: httpx.AsyncClient, tid):
        async with semaphore:
            try:
                return await client.get(f"https://wings.danbiedu.co.kr/api/v1/tickets/{tid}", headers=headers)
            except Exception as e:
                return e

    async with httpx.AsyncClient(timeout=10) as client:
        responses = await asyncio.gather(*[_fetch_one(client, tid) for tid in ticket_ids])
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
    """09:00 수집: collect_new()와 동일하게 신규분을 수집한다.
    예전엔 여기서 인사이트 캐시도 같이 갱신했는데, Wings 티켓·학부모 반복 인입을 각자 다른
    시각에 독립적으로 자동 갱신할 수 있게 분리하면서(자동화 관리에서 설정) 이 함수에서는 뺐다
    — wings_refresh_job/repeat_parents_refresh_job이 각자 등록된 시각에 알아서 돈다."""
    await collect_new(trigger="아침보정")


async def collect_night_catchup():
    """심야(00:00) 수집."""
    await collect_new(trigger="심야보정")


async def update_wings_cache(mode: str = "manual"):
    """Wings 티켓 캐시(wings_tickets·wings_summary)만 갱신한다. 수동(관리자의 반복 Wings 티켓
    페이지 새로고침)·자동(자동화 관리에서 설정한 시각) 양쪽에서 호출되는 공용 함수라 감사
    로그 기록도 여기 한 곳에서만 남긴다. mode는 호출부가 명시해서 수동/자동을 구분한다.
    조회 기간을 180일로 잡는다 — "장기미해결(30일+)"까지 놓치지 않으려면 30일보다 넉넉하게
    봐야 한다. compute_wings_tickets가 CS 건수 상위 N개로 자르지 않고 180일 내 언급된 티켓을
    전부 반환하므로(예전엔 50개로 잘라서 "전체 티켓" 요약 자체가 틀렸었다), Wings API 조회
    대상도 그만큼 늘어난다 — 지난 갱신에서 이미 해결/요청취소/merged로 확인된 티켓은 이번엔
    다시 묻지 않고 그 상태를 재사용해서 API 호출을 줄인다(재오픈되는 사례는 드물다고 보고
    감수한다)."""
    end = str(date.today())
    start = str(date.today() - timedelta(days=180))
    wings = compute_wings_tickets(start, end)
    closed_states = ("해결", "요청취소", "merged")
    if wings:
        prev_row = _read_cache("wings_tickets")
        prev_states = {t["ticket_id"]: t["state"] for t in json.loads(prev_row["data"])} if prev_row else {}

        to_check = [t["ticket_id"] for t in wings if prev_states.get(t["ticket_id"]) not in closed_states]
        states = await _fetch_wings_states(to_check)
        for t in wings:
            reused = prev_states.get(t["ticket_id"])
            t["state"] = reused if reused in closed_states else states.get(str(t["ticket_id"]), "확인불가")
        # 해결된 티켓도 캐시에 그대로 남긴다 — "전체 티켓" 카드에서 전체/미해결/해결 필터로
        # 골라볼 수 있어야 해서, 상태로 걸러내지 않고 스냅샷 건수(전체·해결)만 같이 남긴다.
        summary = {"total": len(wings), "resolved": sum(1 for t in wings if t["state"] in closed_states)}
    else:
        summary = {"total": 0, "resolved": 0}
    _save_wings_cache(wings, summary)
    # 7일+/30일+ 처리 지연 건수를 오늘 날짜로 하루 1건 기록한다 — 과거 상태를 저장해둔 적이
    # 없어서, 주간 추이 차트는 이제부터 쌓이는 값으로만 그릴 수 있다.
    delayed_7, delayed_30 = compute_wings_delay_counts(wings)
    _save_wings_delay_snapshot(str(date.today()), delayed_7, delayed_30)
    log_action("wings_cache_refresh", mode=mode)
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now}] wings cache updated")


async def update_repeat_parents_cache(mode: str = "manual"):
    """학부모 반복 인입 캐시(repeat_parents)만 갱신한다. 수동(관리자의 학부모 반복 인입 페이지
    새로고침)·자동(자동화 관리에서 설정한 시각) 양쪽에서 호출되는 공용 함수다."""
    end = str(date.today())
    start = str(date.today() - timedelta(days=180))
    parents = compute_repeat_parents(start, end)
    _save_repeat_parents_cache(parents)
    log_action("repeat_parents_cache_refresh", mode=mode)
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now}] repeat parents cache updated")


async def _wings_refresh_job():
    """자동화 관리에서 설정한 시각에 도는 Wings 캐시 자동 갱신. daily/weekly 보고서 자동
    생성과 같은 on/off 설정(report_generation_settings 테이블, report_type='wings_refresh')을
    재사용한다 — 테이블·컬럼 이름은 "보고서 생성" 전용으로 지어졌지만 on/off + 시각이라는
    형태 자체는 그대로 맞아서 새 테이블을 만들지 않고 재사용하기로 했다."""
    from core.report_generation_settings import get_generation_settings
    if not get_generation_settings("wings_refresh")["enabled"]:
        log_action("wings_cache_refresh_skipped", "자동 갱신 꺼짐", mode="auto")
        return
    await update_wings_cache(mode="auto")


async def _repeat_parents_refresh_job():
    """자동화 관리에서 설정한 시각에 도는 학부모 반복 인입 캐시 자동 갱신."""
    from core.report_generation_settings import get_generation_settings
    if not get_generation_settings("repeat_parents_refresh")["enabled"]:
        log_action("repeat_parents_cache_refresh_skipped", "자동 갱신 꺼짐", mode="auto")
        return
    await update_repeat_parents_cache(mode="auto")


async def _generate_yesterday_report():
    """직전 영업일 일별 보고서를 자동 생성한다. COLLECTION_ENABLED 무관하게 실행.
    단순히 "어제"가 아니라 previous_business_day()로 주말·공휴일을 건너뛴 직전 영업일을
    대상으로 한다 — 월요일에 도는 실행이 일요일자(상담 건수 거의 0)를 만드는 대신 지난 금요일자를
    만들도록 하기 위함이다(메일 발송의 previous_business_day 계산과 동일한 이유).
    이미 완전히 성공한 보고서가 있으면(예: 낮에 수동으로 미리 생성해둔 경우) 통째로 다시
    만드는 낭비를 피하려고 건너뛴다 — 이건 "매일 밤 무조건 도는 배치"라는 트리거 특성상 필요한
    판단이라 여기(스케줄러)에 남긴다. 그 외의 실제 생성 로직(카테고리→피크→이상시간대→재시도)은
    수동 '재생성' 버튼과 완전히 동일한 generate_report_full()을 그대로 쓴다 — 트리거만 다르고
    로직 자체가 갈라질 이유가 없다 (예전엔 자동만 이상시간대 분석·5분 간격 재시도가 있는 등
    따로 구현되어 있어서 계속 어긋났었다)."""
    from features.report.report_daily import generate_report_full, get_report, has_gemma_failures
    from core.report_generation_settings import get_generation_settings
    from core.holidays import previous_business_day
    target_date = previous_business_day(str(date.today()))
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    if not get_generation_settings("daily")["enabled"]:
        log_action("daily_report_auto_generate_skipped", f"date={target_date}, reason=자동 생성 꺼짐", mode="auto")
        return
    existing = get_report(target_date)
    if existing and not has_gemma_failures(existing):
        log_action("daily_report_auto_generate_skipped", f"date={target_date}, reason=이미 완성된 보고서 있음", mode="auto")
        print(f"[{now}] 일별 보고서 자동 생성 스킵 (이미 완성됨): {target_date}")
        return
    try:
        await generate_report_full(target_date, mode="auto")
        print(f"[{now}] 일별 보고서 생성 완료: {target_date}")
    except Exception as e:
        log_action("daily_report_auto_generate_failed", f"date={target_date}, error={e}", mode="auto")
        print(f"[{now}] 일별 보고서 생성 실패: {e}")


async def _send_daily_report_mail():
    """관리자 페이지("메일링 관리")에서 설정한 시각에, 직전 영업일 일별 보고서를 메일로
    발송한다. 실제 로직은 features/mailer/daily_report_mailer.py가 담당하고(on/off·휴무일·
    보고서 없음·마감시간 초과 스킵 포함), 여기서는 예외가 새어나가 스케줄러 자체가 죽지
    않도록 감싸기만 한다."""
    from features.mailer.daily_report_mailer import send_daily_report_mail
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    try:
        await send_daily_report_mail()
        print(f"[{now}] 일별 보고서 메일 발송 처리 완료")
    except Exception as e:
        log_action("daily_report_mail", f"status=failed, error={e}", mode="auto")
        print(f"[{now}] 일별 보고서 메일 발송 실패: {e}")


async def _send_weekly_report_mail():
    """관리자 페이지("메일링 관리")에서 설정한 시각에, 직전 주 주간 보고서를 메일로 발송한다.
    실제 로직은 features/mailer/weekly_report_mailer.py가 담당한다."""
    from features.mailer.weekly_report_mailer import send_weekly_report_mail
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    try:
        await send_weekly_report_mail()
        print(f"[{now}] 주간 보고서 메일 발송 처리 완료")
    except Exception as e:
        log_action("weekly_report_mail", f"status=failed, error={e}", mode="auto")
        print(f"[{now}] 주간 보고서 메일 발송 실패: {e}")


# report_type('daily'/'weekly') → 그 메일링의 cron job id·핸들러. mail_endpoints.py가
# 설정 저장 직후 reschedule_mail_job()을 불러 이 job의 시각을 즉시 새로 등록한다 —
# 서버 재시작 없이 바로 다음 발송부터 바뀐 시각이 반영되게 하기 위함.
_MAIL_JOB_IDS = {"daily": "daily_report_mail_job", "weekly": "weekly_report_mail_job"}
_MAIL_JOB_HANDLERS = {"daily": _send_daily_report_mail, "weekly": _send_weekly_report_mail}

_scheduler_instance: AsyncIOScheduler | None = None


def _register_mail_jobs(scheduler: AsyncIOScheduler) -> None:
    from core.mail_settings import get_mail_settings
    for report_type, handler in _MAIL_JOB_HANDLERS.items():
        settings = get_mail_settings(report_type)
        scheduler.add_job(
            handler, "cron", hour=settings["send_hour"], minute=settings["send_minute"],
            id=_MAIL_JOB_IDS[report_type],
        )


def reschedule_mail_job(report_type: str) -> None:
    """메일링 관리 설정 저장 직후 호출한다. 저장된 새 send_hour/send_minute으로 해당
    report_type의 cron job을 다시 등록한다."""
    from core.mail_settings import get_mail_settings
    if _scheduler_instance is None:
        return
    settings = get_mail_settings(report_type)
    _scheduler_instance.reschedule_job(
        _MAIL_JOB_IDS[report_type], trigger="cron",
        hour=settings["send_hour"], minute=settings["send_minute"],
    )


async def _generate_last_week_report():
    """직전 주 월요일 날짜를 계산해 주간 보고서를 자동 생성한다. COLLECTION_ENABLED 무관하게 실행.
    일별과 동일하게 카테고리별 부분 실패를 반환값에서 확인해 감사 로그에 남긴다."""
    from features.report.report_weekly import generate_weekly_report
    from core.report_generation_settings import get_generation_settings
    today = date.today()
    last_monday = str(today - timedelta(days=today.weekday() + 7))
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
    if not get_generation_settings("weekly")["enabled"]:
        log_action("weekly_report_auto_generate_skipped", f"week_start={last_monday}, reason=자동 생성 꺼짐", mode="auto")
        return
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


# report_type('daily'/'weekly'/'wings_refresh'/'repeat_parents_refresh') → 그 자동 실행의
# cron job id·핸들러·요일 제약. generation_settings_endpoints.py가 설정 저장 직후
# reschedule_generation_job()을 불러 이 job의 시각을 즉시 새로 등록한다 — reschedule_mail_job()과
# 동일한 방식. 주간 보고서는 "직전 주(월~일)"가 대상이라 매주 월요일에만 돌아야 해서
# day_of_week가 고정이다.
# wings_refresh/repeat_parents_refresh는 "보고서 생성"이 아니라 인사이트 캐시 갱신이지만,
# on/off + 시각이라는 설정 형태 자체는 report_generation_settings 테이블과 완전히 같아서
# 새 테이블·새 스케줄링 코드를 만들지 않고 이 메커니즘을 그대로 재사용한다.
_GENERATION_JOB_IDS = {
    "daily": "daily_report_generate_job", "weekly": "weekly_report_generate_job",
    "wings_refresh": "wings_refresh_job", "repeat_parents_refresh": "repeat_parents_refresh_job",
}
_GENERATION_JOB_HANDLERS = {
    "daily": _generate_yesterday_report, "weekly": _generate_last_week_report,
    "wings_refresh": _wings_refresh_job, "repeat_parents_refresh": _repeat_parents_refresh_job,
}
_GENERATION_JOB_DAY_OF_WEEK = {"daily": None, "weekly": "mon", "wings_refresh": None, "repeat_parents_refresh": None}


def _register_generation_jobs(scheduler: AsyncIOScheduler) -> None:
    from core.report_generation_settings import get_generation_settings
    for report_type, handler in _GENERATION_JOB_HANDLERS.items():
        settings = get_generation_settings(report_type)
        scheduler.add_job(
            handler, "cron", hour=settings["generate_hour"], minute=settings["generate_minute"],
            day_of_week=_GENERATION_JOB_DAY_OF_WEEK[report_type],
            id=_GENERATION_JOB_IDS[report_type],
        )


def reschedule_generation_job(report_type: str) -> None:
    """자동화 관리 화면의 생성 설정 저장 직후 호출한다. 저장된 새 generate_hour/minute으로
    해당 report_type의 cron job을 다시 등록한다."""
    from core.report_generation_settings import get_generation_settings
    if _scheduler_instance is None:
        return
    settings = get_generation_settings(report_type)
    _scheduler_instance.reschedule_job(
        _GENERATION_JOB_IDS[report_type], trigger="cron",
        hour=settings["generate_hour"], minute=settings["generate_minute"],
        day_of_week=_GENERATION_JOB_DAY_OF_WEEK[report_type],
    )


# ── 스케줄 약속 ────────────────────────────────────────────────────────────────
# 언제 무엇을 실행할지 여기서만 등록한다.
# 시간 변경·신규 작업 추가는 이 함수만 수정하면 된다.

def _register_jobs(scheduler: AsyncIOScheduler) -> None:
    # 일별/주간 보고서 생성: 시각은 관리자 페이지("자동화 관리")에서 설정한 값을 그대로
    # 읽어와 등록한다 (기본 00:30). 설정이 바뀌면 reschedule_generation_job()이 즉시 다시 등록한다.
    _register_generation_jobs(scheduler)

    # 일별/주간 보고서 메일 발송: 시각은 관리자 페이지("자동화 관리")에서 설정한 값을 그대로
    # 읽어와 등록한다 (기본 11:00). 설정이 바뀌면 reschedule_mail_job()이 즉시 다시 등록한다.
    _register_mail_jobs(scheduler)

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
    global _scheduler_instance
    scheduler = AsyncIOScheduler(timezone=KST)
    _register_jobs(scheduler)
    scheduler.start()
    _scheduler_instance = scheduler
    return scheduler
