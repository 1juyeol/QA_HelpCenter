# -*- coding: utf-8 -*-
# 해지 사유 · 기기 교체 원인 분석 전용 집계 로직.
# classifier.py는 CS 메모를 카테고리로 "분류"만 하는 반면, 이 파일은 이미 분류된 두 카테고리
# (해지·유지 상담 / 기기 교체 요청) 안에서 "왜"에 해당하는 자유텍스트를 추출·집계한다.
#
# - extract_churn_reason(): "*해지요청 사유 : <내용>" 구조화 필드의 값을 추출한다 (없으면 None).
#   해당 필드가 없는 메모(전체의 약 85%)는 사유가 이질적인 자유 텍스트라 집계 대상에서 제외한다.
# - classify_churn_reason(): 추출된 사유 텍스트를 CHURN_REASON_RULES 키워드로 분류한다.
#   어느 키워드에도 안 걸리면 "사유 미상(단순 요청)"으로 분류 — 상담원이 사유를 남기지 않고
#   요청만 전달한 케이스로, 그 자체로 의미 있는 집계 결과다.
# - extract_device_model(): "*교체학습기 :" / "*교체 학습기 :" 필드에서 기종명을 추출한다.
#   전체 교체 요청의 약 93%가 이 필드를 가지고 있어 별도 분류 규칙 없이 그대로 집계 가능하다.
# - get_churn_reason_stats() / get_device_swap_stats(): core.db.get_conn()으로 issues 테이블을
#   스캔해 위 함수들로 만든 통계를 프론트에서 바로 쓸 수 있는 dict 형태로 반환한다.
import re
from collections import Counter

from core.db import get_conn
from features.issues.classifier import extract_symptom_fields

_HAEJI_REASON = re.compile(r"\*해지요청\s*사유\s*[:：]\s*(.+?)(?:\n\*|/\s*\*|\Z)", re.DOTALL)
_DEVICE_FIELD = re.compile(r"\*교체\s*학습기\s*[:：]\s*([^\n/]+)")

CHURN_REASON_RULES = [
    ("위약금·비용 부담", ["위약금", "비싸", "부담", "비용"]),
    ("타 서비스 이동", ["학원", "타사", "캐잉", "다른 학습지", "타 브랜드", "웅진", "교원", "재능", "눈높이", "빨간펜", "아이스크림", "씽크빅"]),
    ("환불·청약철회", ["환불", "청약철회", "청약 철회", "결제취소", "결제 취소"]),
    ("학습 흥미·효과 저하", ["흥미", "재미없", "효과", "하기 싫", "안 한다", "안한다", "하지 않"]),
    ("생활 변화(이사·전학 등)", ["이사", "전학", "휴학", "졸업", "입학"]),
]
CHURN_REASON_FALLBACK = "사유 미상(단순 요청)"
MAX_EXAMPLES = 30  # 프론트에 내려줄 카드당 예시 원문 개수 상한 — 나머지는 count로만 파악


def extract_churn_reason(memo: str) -> str | None:
    """*해지요청 사유 : <값> 필드의 값을 추출. 필드 없으면 None."""
    m = _HAEJI_REASON.search(memo)
    if not m:
        return None
    val = re.sub(r"\s+", " ", m.group(1)).strip()
    return val or None


def classify_churn_reason(reason: str) -> str:
    """추출된 해지 사유 텍스트를 CHURN_REASON_RULES로 분류."""
    for name, keywords in CHURN_REASON_RULES:
        if any(kw in reason for kw in keywords):
            return name
    return CHURN_REASON_FALLBACK


def extract_device_model(memo: str) -> str | None:
    """*교체학습기 : <기종> 필드의 기종명을 추출. 필드 없으면 None."""
    m = _DEVICE_FIELD.search(memo)
    if not m:
        return None
    val = m.group(1).strip().rstrip("/").strip()
    return val or None


def get_churn_reason_stats() -> dict:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, datetime(created_date, '+9 hours') AS kst_date, call_memo
            FROM issues
            WHERE new_category_main = '해지·유지 상담' AND call_memo LIKE '%해지요청 사유%'
            """
        ).fetchall()

    buckets: dict[str, list[dict]] = {}
    for r in rows:
        reason = extract_churn_reason(r["call_memo"])
        if reason is None:
            continue
        bucket = classify_churn_reason(reason)
        buckets.setdefault(bucket, []).append({
            "id": r["id"],
            "created_date": r["kst_date"],
            "reason": reason,
        })

    total = sum(len(items) for items in buckets.values())
    return {
        "total": total,
        "buckets": [
            {
                "name": name,
                "count": len(items),
                "examples": sorted(items, key=lambda x: x["created_date"], reverse=True)[:MAX_EXAMPLES],
            }
            for name, items in sorted(buckets.items(), key=lambda kv: -len(kv[1]))
        ],
    }


def get_device_swap_stats() -> dict:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, datetime(created_date, '+9 hours') AS kst_date, call_memo
            FROM issues
            WHERE new_category_sub = '기기 교체 요청'
            """
        ).fetchall()

    model_counts: Counter = Counter()
    model_rows: dict[str, list[dict]] = {}
    seonchulgo_count = 0
    for r in rows:
        memo = r["call_memo"] or ""
        model = extract_device_model(memo) or "기종 미상"
        is_seonchulgo = "선출고" in memo
        if is_seonchulgo:
            seonchulgo_count += 1
        model_counts[model] += 1
        model_rows.setdefault(model, []).append({
            "id": r["id"],
            "created_date": r["kst_date"],
            "seonchulgo": is_seonchulgo,
            "memo": memo,
        })

    total = len(rows)
    return {
        "total": total,
        "seonchulgo_count": seonchulgo_count,
        "normal_count": total - seonchulgo_count,
        "models": [
            {
                "model": name,
                "count": count,
                "examples": [
                    {**{k: v for k, v in item.items() if k != "memo"}, "reason": extract_symptom_fields(item["memo"])}
                    for item in sorted(model_rows[name], key=lambda x: x["created_date"], reverse=True)[:MAX_EXAMPLES]
                ],
            }
            for name, count in model_counts.most_common()
        ],
    }
