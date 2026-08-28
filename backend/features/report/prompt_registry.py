# -*- coding: utf-8 -*-
# 자동화 관리의 "프롬프트 편집" 화면이 쓰는 프롬프트 카탈로그. 각 프롬프트의 기본값(코드 상수)·
# 설명·전달되는 데이터 필드 목록을 한곳에 모은다.
#
# 실제 Gemma 호출 코드(report_daily.py/report_weekly.py)는 이 파일을 참조하지 않는다 — 그쪽은
# 각자 core.prompt_settings.get_prompt_text(key, 자기 파일의 기본 상수)를 직접 호출해서 커스텀
# 값을 가져온다. 이 파일은 순전히 관리자 화면에 "지금 프롬프트가 뭐가 있고 뭘 받는지"를 보여주는
# 카탈로그다 — report_daily.py/report_weekly.py를 임포트하기만 하고 반대 방향 의존은 없다(순환 없음).
#
# fields의 used는 시스템 프롬프트 규칙이 그 데이터를 "언급/활용하라"고 명시하는지를 코드와
# 대조해서 사람이 직접 확인해둔 값이다(자동 감지 아님) — True(명시적 지시 있음) /
# "partial"(개별 지시는 없지만 포괄적 지시 범위 안) / False(방치, 아무 지시 없음).
# 시스템 프롬프트 내용을 바꾸면 이 표도 같이 업데이트해야 정확하다.
from features.report.report_utils import _SYSTEM_CATEGORY
from features.report.report_daily import _SYSTEM_PEAK_BUCKET
from features.report.report_weekly import _SYSTEM_WEEKLY_CATEGORY, _SYSTEM_WEEKLY_SUMMARY

PROMPT_REGISTRY = [
    {
        "key": "daily_category",
        "report_type": "daily",
        "order": 1,
        "label": "카테고리 분석",
        "description": "리스크 카테고리(기기·하드웨어 오류, 네트워크·앱 오류 등)마다 하나씩 호출되는데, 카테고리별로 프롬프트가 다른 게 아니라 이 규칙 하나를 전체 카테고리가 공유합니다.",
        "default_text": _SYSTEM_CATEGORY,
        "fields": [
            {"field": "date_str", "desc": "분석 대상 날짜", "used": True},
            {"field": "cat_label", "desc": "지금 분석 중인 카테고리 이름 (호출마다 바뀜)", "used": True},
            {"field": "memos", "desc": "그 카테고리의 CS 메모 — 증상별로 묶여 건수와 함께 제공됨", "used": True},
        ],
    },
    {
        "key": "daily_peak",
        "report_type": "daily",
        "order": 2,
        "label": "피크타임·이상시간대 분석",
        "description": "그날 문의가 가장 몰린 시간대(17~20시) 분석과, 피크타임이 아닌데 유독 몰린 시간대가 있을 때의 분석이 이 규칙 하나를 공유합니다.",
        "default_text": _SYSTEM_PEAK_BUCKET,
        "fields": [
            {"field": "date_str", "desc": "날짜", "used": True},
            {"field": "bucket_start / bucket_end", "desc": "분석 대상 시간 구간", "used": True},
            {"field": "bucket_count", "desc": "그 구간 접수 건수", "used": True, "note": "규칙: 반복하지 말고 배경으로만 참고"},
            {"field": "avg_count / peak_count", "desc": "비교 기준(피크타임 평균 또는 그날 최다 버킷)", "used": True, "note": "규칙: 반복하지 말고 배경으로만 참고"},
            {"field": "breakdown", "desc": "그 구간의 카테고리별 분포", "used": True, "note": "규칙: 반복하지 말고 배경으로만 참고"},
        ],
    },
    {
        "key": "weekly_category",
        "report_type": "weekly",
        "order": 1,
        "label": "카테고리 분석",
        "description": "리스크 카테고리마다 하나씩 호출되며, 일별과 마찬가지로 카테고리 전체가 규칙 하나를 공유합니다. 일별과는 별개 프롬프트라 여기를 고쳐도 일별엔 영향이 없습니다.",
        "default_text": _SYSTEM_WEEKLY_CATEGORY,
        "fields": [
            {"field": "week_range", "desc": "분석 대상 주(월~일)", "used": True},
            {"field": "cat_label", "desc": "지금 분석 중인 카테고리 이름", "used": True},
            {"field": "count", "desc": "이 카테고리의 이번 주 전체 건수", "used": False, "note": "이미 화면(카드 배지)에 표시됨"},
            {"field": "risk_pct", "desc": "이번 주 전체 리스크 CS 중 이 카테고리 비중", "used": True, "note": "규칙 마지막 줄: 사유와 부합하면 포함"},
            {"field": "peak_day / peak_count", "desc": "이 카테고리 문의가 가장 많았던 요일과 그날 건수", "used": True, "note": "규칙 마지막 줄: 사유와 부합하면 포함"},
            {"field": "top_keywords", "desc": "이 카테고리 메모에서 자주 등장한 단어", "used": True, "note": "규칙 마지막 줄: 사유와 부합하면 포함"},
            {"field": "memos", "desc": "증상별로 묶인 메모와 건수", "used": True},
        ],
    },
    {
        "key": "weekly_summary",
        "report_type": "weekly",
        "order": 2,
        "label": "종합 분석",
        "description": "카테고리별 분석이 전부 끝난 뒤, 그 결과와 이번 주 통계를 종합해서 3~4줄 브리핑을 만드는 단계입니다. 일별 보고서엔 이 단계 자체가 없습니다(카테고리 분석까지만 함).",
        "default_text": _SYSTEM_WEEKLY_SUMMARY,
        "fields": [
            {"field": "week_range", "desc": "분석 대상 주", "used": True},
            {"field": "total_weekday", "desc": "이번 주 총 상담 건수(평일 기준)", "used": "partial", "note": "개별 지시는 없지만 '종합 분석하라'는 포괄 지시 범위 안"},
            {"field": "daily_avg", "desc": "일평균 상담 건수", "used": "partial", "note": "개별 지시는 없지만 '종합 분석하라'는 포괄 지시 범위 안"},
            {"field": "risk_total", "desc": "이번 주 리스크 CS 건수", "used": "partial", "note": "개별 지시는 없지만 '종합 분석하라'는 포괄 지시 범위 안"},
            {"field": "risk_pct", "desc": "전체 상담 중 리스크 비율", "used": "partial", "note": "개별 지시는 없지만 '종합 분석하라'는 포괄 지시 범위 안"},
            {"field": "category_summary", "desc": "카테고리별 건수 목록", "used": "partial", "note": "개별 지시는 없지만 '종합 분석하라'는 포괄 지시 범위 안"},
            {"field": "risk_analysis", "desc": "카테고리 분석 단계에서 이미 나온 요약문들", "used": True, "note": "규칙: '제공된 분석에 나타난 내용만' 명시"},
        ],
    },
]


def get_prompt_meta(key: str) -> dict | None:
    return next((p for p in PROMPT_REGISTRY if p["key"] == key), None)
