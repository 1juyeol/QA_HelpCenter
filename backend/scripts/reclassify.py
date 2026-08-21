# 전체 이슈 재분류 스크립트 (정책 4: 분류 규칙 변경 후 전체 재적용).
# issues 테이블의 모든 행에 classifier.py의 최신 RULES를 다시 적용한다.
# 실행 방법: cd backend && python scripts/reclassify.py
# 주요 흐름: get_conn()으로 전체 행 조회 → classify(call_memo)로 대분류·소분류 재계산
#           → classify가 (None,None)이면 scheduler.py와 동일하게 ('기타','기타')로 확정
#           → 변경된 행만 집계(특히 기타 → 타 카테고리 흡수량)하고 executemany로 일괄 UPDATE.
# 의존: core/db.py(get_conn), features/issues/classifier.py(classify)
# 주의: RULES를 바꾼 뒤 반드시 실행해야 과거 데이터까지 새 규칙이 반영된다 (정책 4).
#       (이전 버전은 NULL/미분류 행만 처리해 기존 '기타' 행에 규칙 변경을 반영하지 못했다.)
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.db import get_conn
from features.issues.classifier import classify


def run():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, call_memo, new_category_main AS m, new_category_sub AS s FROM issues"
        ).fetchall()

        updates = []
        changed = 0
        etc_reclaimed = 0  # '기타'였다가 다른 대분류로 이동한 건수
        for r in rows:
            main, sub = classify(r["call_memo"])
            if main is None:
                main, sub = "기타", "기타"
            if (main, sub) != (r["m"], r["s"]):
                changed += 1
                if r["m"] == "기타" and main != "기타":
                    etc_reclaimed += 1
            updates.append((main, sub, r["id"]))

        conn.executemany(
            "UPDATE issues SET new_category_main = ?, new_category_sub = ? WHERE id = ?",
            updates,
        )
        conn.commit()

    print(f"총 {len(rows)}건 재분류 → 변경 {changed}건 (그 중 기타 → 타 카테고리 흡수 {etc_reclaimed}건)")


if __name__ == "__main__":
    run()
