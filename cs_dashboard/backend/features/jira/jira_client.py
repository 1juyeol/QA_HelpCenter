# -*- coding: utf-8 -*-
# JIRA 미해결 서비스 버그 목록 조회 및 CS 메모 매칭 클라이언트.
# DQ-424 에픽 하위 이슈 중 [학생앱]·[학부모앱]·[PC홈페이지] 태그가 있고 종료·완료 아닌 이슈만 대상.
#
# 주요 흐름:
#   1. fetch_jira_bugs()       → JIRA REST API(/rest/api/3/search/jql)로 이슈 수집 (페이지네이션)
#   2. extract_keywords()      → 이슈 요약에서 불용어 제거 후 CS 검색용 키워드 최대 3개 추출
#   3. _compute_cs_count()     → call_memo LIKE 검색(OR)으로 연관 CS 건수 집계
#   4. sync_bugs()             → 위 결과를 jira_issues 테이블에 UPSERT (60분 TTL)
#   5. get_bugs()              → 캐시 조회, TTL 초과 시 자동 sync 후 반환
#   6. get_bug_memos(key)      → 특정 이슈의 키워드로 CS 메모 전체 조회
#
# 의존: core/db.get_conn(), .env의 JIRA_EMAIL·JIRA_TOKEN·JIRA_BASE_URL·JIRA_EPIC_KEY

import os
import re
import base64
from datetime import datetime, timedelta

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
SYNC_TTL_MINUTES = 60

STOP_WORDS = {
    "화면에서", "화면이", "화면을", "화면으로", "화면",
    "상태에서", "상태일", "상태로", "상태가",
    "기능의", "기능이", "기능을", "기능",
    "설정이", "설정의", "설정을",
    "선택시", "선택한", "선택",
    "경우", "이동", "이동시", "진입시", "진입",
    "동작합니다", "동작시", "동작",
    "노출되는", "노출됩니다", "노출되지", "노출",
    "확인", "현상이", "현상", "이슈", "문제", "버그", "개선", "요청", "검토",
    "학습이", "학습을", "학습의", "학습",
    "콘텐츠가", "콘텐츠를", "콘텐츠", "컨텐츠가", "컨텐츠를", "컨텐츠",
    "단말기에서", "단말기로", "단말기를", "단말기가", "단말기",
    "앱이", "앱을", "앱에서", "앱",
    "회원이", "회원의", "회원일", "회원",
    "학생에게", "학생앱이", "학부모앱이", "학부모앱에서",
    "재생이", "재생시", "재생을", "재생",
    "시도시", "완료시", "완료후", "사용시", "사용",
    "진행시", "진행", "처리", "변경시", "변경후", "변경",
    "아이의", "아이에게",
    "않는", "않습니다", "됩니다",
    "발생합니다", "발생되는", "발생",
    "보여집니다",
    "기존에", "기존의", "특정", "임의의",
    "윙크", "KOR", "통합",
    "페이지", "화면은", "꺼져있으나", "시작되기",
}


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


def extract_keywords(summary: str, description: str = "") -> list:
    combined = summary + " " + description
    clean = re.sub(r"\[[^\]]+\]", "", combined).strip()
    quoted = re.findall(r'[“”"](.*?)[“”"]', clean)
    clean2 = re.sub(r'[“”"](.*?)[“”"]', "", clean)
    words = re.split(r"[\s,./\->&<]+", clean2)

    result = []
    for q in quoted:
        q = q.strip()
        if len(q) >= 4 and q not in STOP_WORDS:
            result.append(q)
    for w in words:
        w = w.strip()
        if len(w) >= 3 and w not in STOP_WORDS and not re.match(r"^[a-zA-Z0-9\-_]+$", w):
            result.append(w)

    seen, unique = set(), []
    for w in result:
        if w not in seen:
            seen.add(w)
            unique.append(w)
    return unique[:3]


def _compute_cs_count(keywords: list) -> int:
    if not keywords:
        return 0
    # AND: 키워드 전부가 동시에 포함된 메모만 집계 (OR이면 범용어 하나로 수천 건 오집계)
    conditions = " AND ".join(["call_memo LIKE ?" for _ in keywords])
    params = tuple(f"%{kw}%" for kw in keywords)
    with get_conn() as conn:
        row = conn.execute(
            f"SELECT COUNT(*) FROM issues WHERE call_memo IS NOT NULL AND ({conditions})",
            params,
        ).fetchone()
        return row[0] if row else 0


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
        desc_adf = i["fields"].get("description") or {}
        description = _extract_adf_text(desc_adf)
        result.append({
            "key":         i["key"],
            "summary":     summary,
            "description": description,
            "status":      status,
            "created_at":  i["fields"]["created"][:10],
        })
    return result


def sync_bugs() -> None:
    issues    = fetch_jira_bugs()
    synced_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with get_conn() as conn:
        for bug in issues:
            keywords = extract_keywords(bug["summary"], bug.get("description", ""))
            cs_count = _compute_cs_count(keywords)
            conn.execute(
                """
                INSERT INTO jira_issues (key, summary, status, created_at, cs_keywords, cs_count, synced_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                  summary    = excluded.summary,
                  status     = excluded.status,
                  cs_keywords= excluded.cs_keywords,
                  cs_count   = excluded.cs_count,
                  synced_at  = excluded.synced_at
                """,
                (
                    bug["key"], bug["summary"], bug["status"], bug["created_at"],
                    ",".join(keywords), cs_count, synced_at,
                ),
            )
        conn.commit()


def _is_stale() -> bool:
    with get_conn() as conn:
        row = conn.execute("SELECT MAX(synced_at) FROM jira_issues").fetchone()
        if not row or not row[0]:
            return True
        try:
            last = datetime.strptime(row[0], "%Y-%m-%d %H:%M:%S")
            return datetime.now() - last > timedelta(minutes=SYNC_TTL_MINUTES)
        except Exception:
            return True


def get_bugs() -> list:
    if _is_stale():
        sync_bugs()
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT key, summary, status, created_at, cs_count, cs_keywords, synced_at FROM jira_issues ORDER BY cs_count DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def get_bug_memos(key: str) -> list:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT cs_keywords FROM jira_issues WHERE key = ?", (key,)
        ).fetchone()
        if not row or not row["cs_keywords"]:
            return []

        keywords = [kw for kw in row["cs_keywords"].split(",") if kw]
        if not keywords:
            return []

        conditions = " AND ".join(["call_memo LIKE ?" for _ in keywords])
        params     = tuple(f"%{kw}%" for kw in keywords)
        memos = conn.execute(
            f"""
            SELECT created_date, category_main, category_sub, call_memo
            FROM issues
            WHERE call_memo IS NOT NULL AND ({conditions})
            ORDER BY created_date DESC
            """,
            params,
        ).fetchall()
        return [dict(m) for m in memos]
