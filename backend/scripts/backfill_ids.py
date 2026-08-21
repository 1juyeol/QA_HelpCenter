# student_id·parent_id 누락 이슈 일괄 보완 스크립트.
# issues 테이블에서 student_id가 NULL인 날짜를 찾아 Helpdesk API를 재호출해 ID를 채운다.
# 실행 방법: cd backend && python scripts/backfill_ids.py
# 주요 흐름: student_id=NULL 날짜 목록 조회 → Helpdesk 로그인(아이디·비밀번호 입력)
#           → 날짜별 100건씩 페이지네이션 조회 → student_id·parent_id UPDATE → 완료 출력.
# 의존: features/collection/helpdesk_client.py(HelpdeskClient), core/db.py(get_conn)
# 주의: API 호출 사이 DELAY(5초) 대기 — rate limit 방어용.
import asyncio
import getpass
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from features.collection.helpdesk_client import HelpdeskClient
from core.db import get_conn

DELAY = 5  # 페이지 호출 간 딜레이(초)


async def run():
    print("help-desk 로그인")
    username = input("  아이디: ")
    password = getpass.getpass("  비밀번호: ")
    print()

    with get_conn() as conn:
        rows = conn.execute(
            "SELECT DISTINCT date(created_date) AS d FROM issues "
            "WHERE student_id IS NULL ORDER BY d"
        ).fetchall()
    dates = [r[0] for r in rows]

    if not dates:
        print("보완할 데이터 없음")
        return

    print(f"대상 날짜: {len(dates)}일 ({dates[0]} ~ {dates[-1]})")

    client = None
    try:
        client = await HelpdeskClient.login(username, password)

        # HelpdeskClient.fetch_issues에 딜레이 적용을 위해 직접 페이지네이션
        for d_str in dates:
            target = date.fromisoformat(d_str)
            offset = 0
            total_updated = 0

            while True:
                resp = await client.client.get(
                    "https://help-desk-api.wink.co.kr/issue/issues/",
                    params={
                        "model_type": 1009,
                        "is_complete": "true",
                        "limit": 100,
                        "offset": offset,
                        "created_date": f"{d_str},{d_str}",
                        "search": "",
                        "order_by": "-dpo,-id",
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                results = data.get("results", [])

                updates = [
                    (r.get("student"), r.get("parent"), r["id"])
                    for r in results
                ]
                with get_conn() as conn:
                    conn.executemany(
                        "UPDATE issues SET student_id=?, parent_id=? WHERE id=?",
                        updates,
                    )
                    conn.commit()
                total_updated += len(updates)

                if not data.get("next"):
                    break
                offset += 100
                print(f"  [{d_str}] {offset}건 처리 중... ({DELAY}초 대기)")
                await asyncio.sleep(DELAY)

            print(f"[{d_str}] 완료 — {total_updated}건 업데이트")

    finally:
        if client:
            await client.close()

    print("\n완료")


if __name__ == "__main__":
    asyncio.run(run())
