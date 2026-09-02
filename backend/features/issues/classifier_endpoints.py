# -*- coding: utf-8 -*-
# 분류 키워드 관리 API 라우터. 관리자 페이지("분류 키워드 관리")가 사용한다.
#
# GET    /api/admin/classifier/rules         : 소분류별 키워드 전체 목록 + 다른 소분류와 겹치는
#   키워드(duplicate_of) 표시. classifier.py의 RULES를 그대로 읽어서 보여준다 — 이미 비활성화된
#   키워드는 RULES에서 실제로 빠져 있으므로 이 목록에는 "현재 살아있는" 키워드만 나온다.
# DELETE /api/admin/classifier/keyword?sub=&keyword= : 키워드를 비활성화하고, 그 즉시
#   ① RULES에서 실제로 제거(apply_disabled_keywords) ② 전체 이슈 재분류(reclassify.run)까지
#   한 번에 수행한다. 재분류는 최대 수만 건을 순회하므로 몇 초 걸릴 수 있다 — 응답이 그 결과를
#   그대로 반환하므로 화면에서 "몇 건 바뀌었는지"를 바로 보여줄 수 있다.
from collections import defaultdict
from fastapi import APIRouter, Depends, HTTPException, Query

from core.classifier_keyword_settings import disable_keyword
from features.admin.admin_endpoints import require_admin
from core.audit_log import log_action
from features.issues.classifier import RULES, apply_disabled_keywords
from scripts.reclassify import run as run_reclassify

router = APIRouter()


@router.get("/api/admin/classifier/rules")
def get_classifier_rules(_: None = Depends(require_admin)):
    kw_to_subs: dict[str, list[str]] = defaultdict(list)
    for sub, kws in RULES:
        for k in kws:
            kw_to_subs[k].append(sub)

    return [
        {
            "sub": sub,
            "keywords": [
                {"keyword": k, "duplicate_of": [s for s in kw_to_subs[k] if s != sub] or None}
                for k in kws
            ],
        }
        for sub, kws in RULES
    ]


@router.delete("/api/admin/classifier/keyword")
def delete_classifier_keyword(
    sub: str = Query(...), keyword: str = Query(...), _: None = Depends(require_admin)
):
    valid_subs = {s for s, _ in RULES}
    if sub not in valid_subs:
        raise HTTPException(status_code=400, detail=f"sub는 {', '.join(sorted(valid_subs))} 중 하나여야 합니다")

    disable_keyword(sub, keyword)
    apply_disabled_keywords()
    log_action("classifier_keyword_disabled", f"sub={sub}, keyword={keyword}")
    result = run_reclassify(mode="manual")
    return {"sub": sub, "keyword": keyword, "reclassify_result": result}
