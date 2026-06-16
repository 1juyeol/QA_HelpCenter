# SQLite 연결 관리 및 테이블 스키마 초기화. DB 파일 경로·row_factory 설정이 여기에 집중된다.
# get_conn()을 통해서만 연결을 열며, 코드 어디서도 sqlite3.connect()를 직접 호출하지 않는다 (정책 3).
# init_db()는 서버 시작 시 한 번 호출되며, 테이블·컬럼·인덱스를 없으면 생성·있으면 스킵하는 멱등 방식으로 동작한다.
# 관리하는 테이블: issues(CS 이슈), collection_log(수집 이력), insights_cache(인사이트 집계 캐시),
#                  jira_issues(JIRA 미해결 버그 캐시 — CS 메모 매칭 건수 포함).
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "cs_dashboard.db"


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS issues (
                id INTEGER PRIMARY KEY,
                created_date TEXT NOT NULL,
                complete_date TEXT,
                category_tag INTEGER,
                category_main TEXT,
                category_sub TEXT,
                category_full TEXT,
                call_memo TEXT
            )
        """)
        for col in ["call_memo TEXT", "student_id INTEGER", "parent_id INTEGER"]:
            try:
                conn.execute(f"ALTER TABLE issues ADD COLUMN {col}")
            except Exception:
                pass
        conn.execute("CREATE INDEX IF NOT EXISTS idx_created_date ON issues(created_date)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS collection_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collected_at TEXT DEFAULT (datetime('now', 'localtime')),
                date_target TEXT,
                count_fetched INTEGER,
                status TEXT,
                message TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS insights_cache (
                key TEXT PRIMARY KEY,
                data TEXT,
                updated_at TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS jira_issues (
                key TEXT PRIMARY KEY,
                summary TEXT NOT NULL,
                status TEXT,
                created_at TEXT,
                cs_keywords TEXT,
                cs_count INTEGER DEFAULT 0,
                synced_at TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS reports (
                report_date  TEXT PRIMARY KEY,
                report_type  TEXT NOT NULL DEFAULT 'daily',
                content      TEXT NOT NULL,
                generated_at TEXT NOT NULL
            )
        """)
        conn.commit()
