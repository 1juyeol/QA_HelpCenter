# SQLite 연결 관리 및 테이블 스키마 초기화. DB 파일 경로·row_factory 설정이 여기에 집중된다.
# get_conn()을 통해서만 연결을 열며, 코드 어디서도 sqlite3.connect()를 직접 호출하지 않는다 (정책 3).
# init_db()는 서버 시작 시 한 번 호출되며, 테이블·컬럼·인덱스를 없으면 생성·있으면 스킵하는 멱등 방식으로 동작한다.
# 관리하는 테이블: issues(CS 이슈), collection_log(수집 이력), insights_cache(인사이트 집계 캐시),
#                  jira_issues(JIRA 미해결 버그 캐시 — CS 메모 매칭 건수 포함),
#                  audit_log(관리자 제어 액션·보고서 생성 이력 — core/audit_log.py가 기록·조회 담당).
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "helpdesk.db"


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
        # 대부분의 날짜 필터(정책 2)는 date(datetime(created_date, '+9 hours'))로 KST 변환해 비교한다.
        # 위 idx_created_date는 원본 컬럼 인덱스라 이 변환식에는 안 먹혀서(함수로 감싸면 인덱스를
        # 못 씀) 매번 전체 스캔이 일어난다. 지금(수만 건)은 체감 안 되지만 수십만~수백만 건으로
        # 늘어나면 느려지므로, 실제 쿼리와 동일한 표현식으로 인덱스를 하나 더 만들어둔다.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_created_date_kst "
            "ON issues (date(datetime(created_date, '+9 hours')))"
        )
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
        try:
            # last_id: 이 호출 시작 시점의 커서(직전까지 저장된 issues.id의 최댓값).
            # 호출별로 정확히 무엇을 가져왔는지 나중에 복원할 때 쓴다(id > last_id 구간).
            conn.execute("ALTER TABLE collection_log ADD COLUMN last_id INTEGER")
        except Exception:
            pass
        try:
            # end_id: 이 호출로 새로 받은 것 중 가장 큰 id (없으면 last_id와 동일).
            # last_id~end_id를 관리자 페이지 로그 목록에 그대로 표시해 범위를 한눈에 보여준다.
            conn.execute("ALTER TABLE collection_log ADD COLUMN end_id INTEGER")
        except Exception:
            pass
        try:
            # source: 이 호출을 일으킨 주체 라벨 (정기/아침보정/심야보정/서버시작/수동).
            conn.execute("ALTER TABLE collection_log ADD COLUMN source TEXT")
        except Exception:
            pass
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
        conn.execute("""
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                action TEXT NOT NULL,
                detail TEXT
            )
        """)
        try:
            # mode: 'manual'(사람이 버튼 클릭) / 'auto'(스케줄러가 자동 실행). 감사 로그 화면의
            # 수동·자동 필터 드롭다운이 이 값을 그대로 사용한다.
            conn.execute("ALTER TABLE audit_log ADD COLUMN mode TEXT DEFAULT 'manual'")
        except Exception:
            pass
        conn.commit()
