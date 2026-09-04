# -*- coding: utf-8 -*-
# JIRA 미해결 서비스 버그 목록 조회 클라이언트.
# DQ-424 에픽 하위 이슈 중 [학생앱]·[학부모앱]·[PC홈페이지] 태그가 있고 종료·완료 아닌 이슈만 대상.
#
# 주요 흐름:
#   1. fetch_jira_bugs()        → JIRA REST API(/rest/api/3/search/jql)로 미해결 이슈 수집 (페이지네이션)
#   2. sync_bugs()               → 위 결과를 jira_issues 테이블에 UPSERT
#   3. get_bugs()                → 캐시 조회(동기화는 scheduler.py의 백그라운드 갱신 잡이 담당,
#      요청 처리 중에는 절대 JIRA API를 부르지 않는다 — 예전엔 캐시가 60분 지나면 요청 안에서
#      바로 JIRA API를 불러 응답이 느려졌었다)
#   4. compute_card_counts()     → 전체/검토 대기/6개월+/1년+ 방치 건수 집계 (순수 함수, 상담
#      메모 매칭 없이 status·created_at만 본다) — scheduler.py가 jira_bug_snapshots에 기록할 때 씀
#   5. fetch_resolved_jira_bugs()/sync_resolved_bugs()/get_resolved_bugs() → 최근 7일 내 해결된
#      이슈 목록(별도 캐시, jira_resolved_issues). 미해결 이슈와는 반대로 종료·완료·DROP 상태만
#      대상으로 하고, resolutiondate가 최근 7일 이내인 것만 가져온다.
#
# 의존: core/db.get_conn(), .env의 JIRA_EMAIL·JIRA_TOKEN·JIRA_BASE_URL·JIRA_EPIC_KEY

import os
import base64
from datetime import date, datetime

import requests as req_lib
from dotenv import load_dotenv

from core.db import get_conn

load_dotenv()

_EMAIL    = os.environ.get("JIRA_EMAIL", "")
_TOKEN    = os.environ.get("JIRA_TOKEN", "")
_BASE_URL = os.environ.get("JIRA_BASE_URL", "https://danbiedu-dev.atlassian.net")
_EPIC_KEY = os.environ.get("JIRA_EPIC_KEY", "DQ-424")

EXCLUDE_STATUS   = {"종료", "완료", "DROP"}
SERVICE_TAGS     = ["학생앱", "학부모앱", "PC홈페이지", "PC 웹"]

# "검토 대기" 카드 기준 — JIRA 기본 오픈 상태('미해결')는 아직 아무도 손대지 않은 이슈를 뜻한다.
PENDING_REVIEW_STATUS = "미해결"
SIX_MONTH_DAYS = 180
ONE_YEAR_DAYS = 365


def _auth_header() -> dict:
    encoded = base64.b64encode(f"{_EMAIL}:{_TOKEN}".encode()).decode()
    return {"Authorization": f"Basic {encoded}", "Content-Type": "application/json"}


def _extract_adf_text(node: dict | None) -> str:
    """JIRA ADF(Atlassian Document Format) 노드에서 평문 텍스트 추출."""
    if not node or not isinstance(node, dict):
        return ""
    if node.get("type") == "text":
        return node.get("text", "")
    parts = [_extract_adf_text(child) for child in node.get("content", [])]
    return " ".join(p for p in parts if p)


def fetch_jira_bugs() -> list:
    if not _EMAIL or not _TOKEN:
        return []

    headers = _auth_header()
    all_issues, next_page = [], None

    while True:
        payload = {
            "jql": f'parent = {_EPIC_KEY} OR "Epic Link" = {_EPIC_KEY}',
            "maxResults": 100,
            "fields": ["summary", "status", "created", "description"],
        }
        if next_page:
            payload["nextPageToken"] = next_page
        try:
            r = req_lib.post(
                f"{_BASE_URL}/rest/api/3/search/jql",
                headers=headers,
                json=payload,
                timeout=15,
            )
            data = r.json()
        except Exception:
            break

        issues = data.get("issues", [])
        all_issues.extend(issues)
        next_page = data.get("nextPageToken")
        if not next_page or not issues:
            break

    result = []
    for i in all_issues:
        status  = i["fields"]["status"]["name"]
        summary = i["fields"]["summary"]
        if status in EXCLUDE_STATUS:
            continue
        if not any(tag in summary for tag in SERVICE_TAGS):
            continue
        result.append({
            "key":         i["key"],
            "summary":     summary,
            "status":      status,
            "created_at":  i["fields"]["created"][:10],
        })
    return result


def fetch_resolved_jira_bugs() -> list:
    """최근 7일 내 해결(종료·완료·DROP 처리)된 이슈를 가져온다.
    fetch_jira_bugs()와 마찬가지로 상태 조건은 JQL이 아니라 응답을 받은 뒤 파이썬에서 상태명
    문자열로 직접 거른다 — 이 JIRA 사이트는 "종료"/"완료" 같은 이름의 상태가 워크플로우마다
    서로 다른 내부 ID로 여러 개 등록돼 있어서, JQL의 status in (...)이 이름으로는 그중 일부
    ID만 매칭하고 나머지(예: DQ-707이 속한 워크플로우의 "종료")는 걸러지지 않는 채로 새서
    누락되는 문제가 있었다. resolutiondate도 이 프로젝트 워크플로우에서 상태 전환 시 채워주지
    않아 거의 항상 비어 있어서(해결일 필드 자체를 안 쓰는 구성), 대신 updated(마지막 수정 시각)
    로 최근 7일 여부를 판단하고 해결일 표시에도 이 값을 쓴다 — resolutiondate가 있으면
    그쪽을 우선한다."""
    if not _EMAIL or not _TOKEN:
        return []

    headers = _auth_header()
    jql = f'(parent = {_EPIC_KEY} OR "Epic Link" = {_EPIC_KEY}) AND updated >= -7d'
    all_issues, next_page = [], None

    while True:
        payload = {
            "jql": jql,
            "maxResults": 100,
            "fields": ["summary", "status", "created", "resolutiondate", "updated"],
        }
        if next_page:
            payload["nextPageToken"] = next_page
        try:
            r = req_lib.post(
                f"{_BASE_URL}/rest/api/3/search/jql",
                headers=headers,
                json=payload,
                timeout=15,
            )
            data = r.json()
        except Exception:
            break

        issues = data.get("issues", [])
        all_issues.extend(issues)
        next_page = data.get("nextPageToken")
        if not next_page or not issues:
            break

    result = []
    for i in all_issues:
        status  = i["fields"]["status"]["name"]
        summary = i["fields"]["summary"]
        if status not in EXCLUDE_STATUS:
            continue
        if not any(tag in summary for tag in SERVICE_TAGS):
            continue
        resolved_at = i["fields"].get("resolutiondate") or i["fields"]["updated"]
        result.append({
            "key":         i["key"],
            "summary":     summary,
            "created_at":  i["fields"]["created"][:10],
            "resolved_at": resolved_at[:10],
        })
    return result


def sync_resolved_bugs() -> None:
    """jira_resolved_issues를 최근 7일 내 해결된 이슈로 완전히 교체한다 — sync_bugs()와 같은
    이유로, 7일이 지나 더 이상 조회되지 않는 이슈는 캐시에서도 같이 지운다."""
    bugs = fetch_resolved_jira_bugs()
    with get_conn() as conn:
        fetched_keys = [b["key"] for b in bugs]
        if fetched_keys:
            placeholders = ",".join("?" for _ in fetched_keys)
            conn.execute(f"DELETE FROM jira_resolved_issues WHERE key NOT IN ({placeholders})", fetched_keys)
        else:
            conn.execute("DELETE FROM jira_resolved_issues")
        for b in bugs:
            conn.execute(
                """
                INSERT INTO jira_resolved_issues (key, summary, created_at, resolved_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                  summary     = excluded.summary,
                  resolved_at = excluded.resolved_at
                """,
                (b["key"], b["summary"], b["created_at"], b["resolved_at"]),
            )
        conn.commit()


def get_resolved_bugs() -> list:
    """캐시(jira_resolved_issues)를 그대로 조회한다. get_bugs()와 같은 이유로 요청 처리 중에는
    절대 JIRA API를 직접 호출하지 않는다."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT key, summary, created_at, resolved_at FROM jira_resolved_issues ORDER BY resolved_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def sync_bugs() -> None:
    """JIRA에서 현재 조건에 맞는 이슈 전체를 가져와 jira_issues를 완전히 교체한다. 이번 조회에
    없는 이슈(종료·완료 처리됐거나 태그가 빠진 경우)는 캐시에서도 지운다 — 예전엔 지우지 않아서
    이미 해결된 이슈가 계속 남아 방치 건수를 부풀리고, 그 이슈의 synced_at도 마지막으로 조회된
    시점에 멈춘 채로 남아 "동기화" 표시가 실제로는 매번 갱신되고 있는데도 멈춘 것처럼 보였다."""
    issues    = fetch_jira_bugs()
    synced_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with get_conn() as conn:
        fetched_keys = [bug["key"] for bug in issues]
        if fetched_keys:
            placeholders = ",".join("?" for _ in fetched_keys)
            conn.execute(f"DELETE FROM jira_issues WHERE key NOT IN ({placeholders})", fetched_keys)
        else:
            conn.execute("DELETE FROM jira_issues")
        for bug in issues:
            conn.execute(
                """
                INSERT INTO jira_issues (key, summary, status, created_at, synced_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                  summary   = excluded.summary,
                  status    = excluded.status,
                  synced_at = excluded.synced_at
                """,
                (bug["key"], bug["summary"], bug["status"], bug["created_at"], synced_at),
            )
        conn.commit()


def get_bugs() -> list:
    """캐시(jira_issues)를 그대로 조회한다. 동기화는 scheduler.py의 jira_refresh 잡이 주기적으로
    백그라운드에서 실행하며, 이 함수는 절대 JIRA API를 직접 호출하지 않는다."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT key, summary, status, created_at, synced_at FROM jira_issues ORDER BY created_at ASC"
        ).fetchall()
        return [dict(r) for r in rows]


def _age_days(created_at: str, today: date | None = None) -> int:
    today = today or date.today()
    return (today - date.fromisoformat(created_at)).days


def compute_card_counts(bugs: list, today: date | None = None) -> dict:
    """전체/검토 대기/6개월 이상 방치/1년 이상 방치 건수를 집계한다. 6개월+/1년+는 서로 겹칠 수
    있는 중첩 구간이다(1년 이상이면 항상 6개월 이상이기도 함) — Wings의 7일+/30일+ 지연 건수와
    같은 구조."""
    today = today or date.today()
    return {
        "total_count": len(bugs),
        "pending_review_count": sum(1 for b in bugs if b["status"] == PENDING_REVIEW_STATUS),
        "six_month_count": sum(1 for b in bugs if _age_days(b["created_at"], today) >= SIX_MONTH_DAYS),
        "one_year_count": sum(1 for b in bugs if _age_days(b["created_at"], today) >= ONE_YEAR_DAYS),
    }


def get_jira_trend(days: int = 100) -> list:
    from datetime import timedelta
    start = str(date.today() - timedelta(days=days))
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT snapshot_date, total_count, pending_review_count, six_month_count, one_year_count "
            "FROM jira_bug_snapshots WHERE snapshot_date >= ? ORDER BY snapshot_date ASC",
            (start,),
        ).fetchall()
    return [dict(r) for r in rows]


async def _init_jira_cache():
    """서버 시작 시 jira_issues가 비어 있을 때만(첫 배포 등) 최초 동기화를 실행한다 — 이미
    캐시가 있으면 스킵하고, 이후 갱신은 scheduler.py의 jira_refresh 잡이 담당한다."""
    with get_conn() as conn:
        has_cache = conn.execute("SELECT 1 FROM jira_issues LIMIT 1").fetchone()
    if not has_cache:
        sync_bugs()
        sync_resolved_bugs()
        save_jira_snapshot(str(date.today()), compute_card_counts(get_bugs()))


def save_jira_snapshot(snapshot_date: str, counts: dict) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO jira_bug_snapshots VALUES (?, ?, ?, ?, ?)",
            (snapshot_date, counts["total_count"], counts["pending_review_count"],
             counts["six_month_count"], counts["one_year_count"]),
        )
        conn.commit()
