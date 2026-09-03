# -*- coding: utf-8 -*-
# SQLite 연결 관리 및 테이블 스키마 초기화. DB 파일 경로·row_factory 설정이 여기에 집중된다.
# get_conn()을 통해서만 연결을 열며, 코드 어디서도 sqlite3.connect()를 직접 호출하지 않는다 (정책 3).
# init_db()는 서버 시작 시 한 번 호출되며, 테이블·컬럼·인덱스를 없으면 생성·있으면 스킵하는 멱등 방식으로 동작한다.
# cs_issues 뷰: issues 중 실제 CS 상담이 아닌 행을 뺀 것. 지금 제외하는 두 가지 모두
#   category_main='타부서이력'(사람이 상담한 게 아니라 다른 부서 시스템이 작업하면서 자동으로
#   남기는 이력)이지만 원인은 다르다:
#     - category_sub='추가배송': 물류 시스템이 배송 처리할 때마다 자동으로 남기는 로그 — 하루에
#       만 건 넘게 쌓여 "총 상담" 등 집계를 크게 부풀린 사례가 있었다.
#     - call_memo가 '재가입선물(...) 정기배송 추가 완료'로 시작하는 행: 재가입 고객에게 사은품
#       (텀블러 등)을 발송했다는 시스템 확인 메시지가 category_sub='상담내용등록'으로 저장되며
#       new_category_sub='배송·회수 처리'로 재분류돼 그 소분류 건수를 부풀린다. sub 자체를
#       통째로 빼면 같은 sub 아래 해지방어팀·플래너팀이 남긴 진짜 상담 기록까지 같이 빠지므로,
#       이 정확한 문구 하나만 콕 집어 제외한다.
#   "총 상담 건수"·카테고리 분포·대시보드 트렌드처럼 실제 CS 업무량을 재는 쿼리는 issues 대신
#   이 뷰를 써야 한다. 반대로 원본을 있는 그대로 봐야 하는 경우(재분류 스크립트, 백필 등)는
#   issues를 그대로 쓴다. 제외 조건을 나중에 넓히면 이 뷰 정의 한 곳만 고치면 된다.
#
#   뷰는 매 서버 시작마다 DROP 후 재생성한다 — CREATE VIEW IF NOT EXISTS만 쓰면 이미 존재하는
#   뷰는 정의가 바뀌어도 그대로 남아있어서, 제외 조건을 늘려도 재배포 후 반영되지 않는다.
#
# 관리하는 테이블: issues(CS 이슈), collection_log(수집 이력), insights_cache(인사이트 집계 캐시),
#                  jira_issues(JIRA 미해결 버그 캐시 — CS 메모 매칭 건수 포함),
#                  audit_log(관리자 제어 액션·보고서 생성 이력 — core/audit_log.py가 기록·조회 담당),
#                  mail_settings(보고서 메일링 설정 — core/mail_settings.py가 기록·조회 담당),
#                  report_generation_settings(보고서 자동 생성 설정 — core/report_generation_settings.py가 기록·조회 담당),
#                  prompt_settings(Gemma 시스템 프롬프트 커스텀 값 — core/prompt_settings.py가 기록·조회 담당,
#                  없으면 코드의 기본 프롬프트 상수를 그대로 씀).
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "helpdesk.db"


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    # WAL(Write-Ahead Logging) 모드: 기본 모드(delete)는 쓰기 중 파일 전체를 잠가서 읽기가
    # 대기해야 한다 — 리포트 재생성처럼 쓰기가 잦은 작업이 돌 때 대시보드 조회가 몇 초씩
    # 멈추는 원인이었다. WAL은 쓰기를 별도 파일(-wal)에 먼저 기록해서 읽기가 쓰기를 기다리지
    # 않는다. PRAGMA는 연결마다 매번 설정해도 비용이 거의 없고, 이미 WAL이면 즉시 반환된다.
    conn.execute("PRAGMA journal_mode=WAL")
    # docker-compose.yml이 helpdesk.db "파일 하나만" 호스트에 바인드 마운트한다 — WAL이 커밋을
    # 잠깐 담아두는 -wal 사이드카 파일은 마운트 대상이 아니라 컨테이너 안에서만 산다. 기본
    # 체크포인트 주기(약 1000페이지)에 도달하기 전에 컨테이너가 재생성되면(재배포 등) -wal에만
    # 있던 최근 커밋이 그대로 사라진다 — 실제로 이렇게 저장된 주간보고서 하나가 없어진 적이
    # 있다. 매 커밋마다 즉시 체크포인트해서 helpdesk.db 파일 자체에 반영되게 한다 — WAL을
    # 쓰는 이유(쓰기 중 읽기 대기 없음)는 유지하면서, 이 마운트 구조에서 반드시 필요한
    # 내구성만 되찾는 절충이다.
    conn.execute("PRAGMA wal_autocheckpoint=1")
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
        conn.execute("DROP VIEW IF EXISTS cs_issues")
        conn.execute("""
            CREATE VIEW cs_issues AS
            SELECT * FROM issues
            WHERE NOT (category_main = '타부서이력' AND category_sub = '추가배송')
              AND NOT (category_main = '타부서이력' AND call_memo LIKE '재가입선물%정기배송 추가 완료%')
        """)
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
        conn.execute("""
            CREATE TABLE IF NOT EXISTS mail_settings (
                report_type     TEXT PRIMARY KEY,
                enabled         INTEGER NOT NULL DEFAULT 1,
                deadline_hour   INTEGER NOT NULL DEFAULT 11,
                deadline_minute INTEGER NOT NULL DEFAULT 0,
                send_hour       INTEGER NOT NULL DEFAULT 11,
                send_minute     INTEGER NOT NULL DEFAULT 0,
                sender_email    TEXT NOT NULL DEFAULT '',
                recipients      TEXT NOT NULL DEFAULT '',
                updated_at      TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS report_generation_settings (
                report_type      TEXT PRIMARY KEY,
                enabled          INTEGER NOT NULL DEFAULT 1,
                generate_hour    INTEGER NOT NULL DEFAULT 0,
                generate_minute  INTEGER NOT NULL DEFAULT 30,
                updated_at       TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS prompt_settings (
                prompt_key   TEXT PRIMARY KEY,
                prompt_text  TEXT NOT NULL,
                updated_at   TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS classifier_disabled_keywords (
                sub         TEXT NOT NULL,
                keyword     TEXT NOT NULL,
                disabled_at TEXT DEFAULT (datetime('now', 'localtime')),
                PRIMARY KEY (sub, keyword)
            )
        """)
        conn.commit()
