# -*- coding: utf-8 -*-
# 전체 이슈 재분류 스크립트 (정책 4: 분류 규칙 변경 후 전체 재적용).
# issues 테이블의 모든 행에 classifier.py의 최신 RULES를 다시 적용한다.
# 실행 방법: cd backend && python scripts/reclassify.py [--mode test]
#   --mode를 안 주면 manual로 남는다. Claude가 검증/작업 차 직접 돌릴 때는 --mode test로
#   실행해서 감사 로그에 사람이 한 게 아니라는 게 구분되게 한다 (core/audit_log.py 참고).
# 주요 흐름: get_conn()으로 전체 행 조회 → classify(call_memo)로 대분류·소분류 재계산
#           → classify가 (None,None)이면 scheduler.py와 동일하게 ('기타','기타')로 확정
#           → 변경된 행만 집계(특히 기타 → 타 카테고리 흡수량, (이전 분류)→(새 분류) 전환별
#             건수 top 5)하고 executemany로 일괄 UPDATE. 이 요약을 감사 로그(issues_reclassify)에
#             남겨서, 나중에 "이 재분류로 뭐가 얼마나 바뀌었는지"를 감사 로그 화면에서 바로 볼 수
#             있게 한다 — 예전엔 이 스크립트가 터미널 출력 한 줄로만 결과를 보여주고 끝나서
#             실행 여부·효과가 기록에 전혀 남지 않았다.
# 의존: core/db.py(get_conn), features/issues/classifier.py(classify), core/audit_log.py(log_action)
# 주의: RULES를 바꾼 뒤 반드시 실행해야 과거 데이터까지 새 규칙이 반영된다 (정책 4).
#       (이전 버전은 NULL/미분류 행만 처리해 기존 '기타' 행에 규칙 변경을 반영하지 못했다.)
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.db import get_conn
from core.audit_log import log_action
from features.issues.classifier import classify


def run(mode: str = "manual") -> dict:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, call_memo, new_category_main AS m, new_category_sub AS s FROM issues"
        ).fetchall()

        updates = []
        changed = 0
        etc_reclaimed = 0  # '기타'였다가 다른 대분류로 이동한 건수
        transitions: dict = {}  # (이전 main>sub, 새 main>sub) -> 건수
        for r in rows:
            main, sub = classify(r["call_memo"])
            if main is None:
                main, sub = "기타", "기타"
            old_key = f"{r['m'] or '미분류'}>{r['s'] or '미분류'}"
            new_key = f"{main}>{sub}"
            if new_key != old_key:
                changed += 1
                if r["m"] == "기타" and main != "기타":
                    etc_reclaimed += 1
                pair = (old_key, new_key)
                transitions[pair] = transitions.get(pair, 0) + 1
            updates.append((main, sub, r["id"]))

        conn.executemany(
            "UPDATE issues SET new_category_main = ?, new_category_sub = ? WHERE id = ?",
            updates,
        )
        conn.commit()

    top_transitions = sorted(transitions.items(), key=lambda kv: -kv[1])[:5]
    transitions_str = "; ".join(f"{old} → {new} ({cnt}건)" for (old, new), cnt in top_transitions)

    result = {"total": len(rows), "changed": changed, "etc_reclaimed": etc_reclaimed}
    detail = f"total={result['total']}, changed={result['changed']}, etc_reclaimed={result['etc_reclaimed']}"
    if transitions_str:
        detail += f", top_changes={transitions_str}"
    log_action("issues_reclassify", detail, mode=mode)

    print(f"총 {result['total']}건 재분류 → 변경 {result['changed']}건 (그 중 기타 → 타 카테고리 흡수 {result['etc_reclaimed']}건)")
    if transitions_str:
        print(f"가장 큰 변화: {transitions_str}")
    return result


if __name__ == "__main__":
    run(mode="test" if "--mode" in sys.argv and "test" in sys.argv else "manual")
