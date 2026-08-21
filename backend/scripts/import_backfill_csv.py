# -*- coding: utf-8 -*-
# 과거 CS 상담 데이터 백필 스크립트 (플랫폼엔지니어링팀이 추출해준 CSV를 issues 테이블에 적재).
# 실행 방법: cd backend && python scripts/import_backfill_csv.py <csv파일경로>
#
# CSV 컬럼: id, created_date, complete_date, category_tag_full_name, call_memo, student, parent
#   → 실시간 수집(helpdesk_client._parse_issue)과 동일한 방식으로 category_tag_full_name을
#     " / " 기준 category_main/category_sub/category_full로 쪼개고, classify()로
#     new_category_main/new_category_sub까지 채운 뒤 INSERT OR REPLACE로 issues에 반영한다.
#
# [중요] 타임존 처리
# CSV의 created_date/complete_date는 "YYYY-MM-DD HH:MM:SS" 형식인데, 오프셋 표기가 없는
# "naive KST" 값이다 (시간대 분포 확인 결과 09~21시에 몰려있어 한국 CS 업무시간과 일치 — KST 맞음).
# 반면 기존 실시간 수집 데이터는 API 원본 그대로 "+09:00" 오프셋이 붙어 있고, 앱의 모든 날짜
# 필터(정책 2)는 datetime(created_date, '+9 hours')로 KST 변환한다는 전제로 짜여 있다.
# naive 값에 그대로 +9시간을 더하면 실제보다 9시간 밀리므로, 저장 시 문자열 끝에 "+09:00"을
# 붙여 기존 포맷과 똑같이 맞춘다 — 그러면 SQLite가 UTC로 정규화했다가 +9시간을 다시 더해
# 원래 KST 값 그대로 복원된다 (실시간 수집 데이터와 동일한 원리, db.py 인덱스 코멘트 참고).
import csv
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.db import get_conn, init_db
from features.issues.classifier import classify


def _kst_offset(raw: str | None) -> str | None:
    """naive 'YYYY-MM-DD HH:MM:SS' 문자열에 +09:00을 붙인다. 빈 값이면 None."""
    raw = (raw or "").strip()
    return f"{raw}+09:00" if raw else None


def parse_row(row: dict) -> dict:
    full_name = (row.get("category_tag_full_name") or "").strip()
    parts = [p.strip() for p in full_name.split(" / ") if p.strip()]
    call_memo = row.get("call_memo") or ""
    main, sub = classify(call_memo)
    if main is None:
        main, sub = "기타", "기타"
    return {
        "id": int(row["id"]),
        "created_date": _kst_offset(row.get("created_date")),
        "complete_date": _kst_offset(row.get("complete_date")),
        "category_tag": None,
        "category_main": parts[0] if parts else None,
        "category_sub": parts[-1] if len(parts) > 1 else (parts[0] if parts else None),
        "category_full": full_name,
        "call_memo": call_memo,
        "new_category_main": main,
        "new_category_sub": sub,
        "student_id": (row.get("student") or "").strip() or None,
        "parent_id": (row.get("parent") or "").strip() or None,
    }


def run(csv_path: str):
    init_db()
    start = time.time()

    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        rows = [parse_row(r) for r in reader]

    print(f"파싱 완료: {len(rows)}건 ({time.time() - start:.1f}초)")

    with get_conn() as conn:
        before = conn.execute("SELECT COUNT(*) FROM issues").fetchone()[0]
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
            rows,
        )
        conn.commit()
        after = conn.execute("SELECT COUNT(*) FROM issues").fetchone()[0]

    print(f"완료. issues 테이블 {before}건 → {after}건 (+{after - before}) ({time.time() - start:.1f}초)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("사용법: python scripts/import_backfill_csv.py <csv파일경로>")
        sys.exit(1)
    run(sys.argv[1])
