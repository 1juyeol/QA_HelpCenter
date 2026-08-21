# -*- coding: utf-8 -*-
# 보고서 생성이 "지금 진행 중인지, 몇 번째 단계인지"를 프로세스 메모리에 기록하는 모듈.
# DB에는 안 남긴다 — 서버가 재시작되면 어차피 진행 중이던 백그라운드 작업도 같이 죽으므로
# 굳이 영속화할 이유가 없다. 이 상태의 목적은 딱 하나: 브라우저를 새로고침해도
# "지금 생성 중이다/몇 번째 카테고리다"를 잃어버리지 않게 하는 것 — 지금까지는 이 진행 상태가
# 브라우저 탭의 자바스크립트 메모리에만 있어서, 새로고침하면 서버는 계속 돌고 있는데
# 화면은 "분석 없음"으로 보이는 문제가 있었다.
#
# (report_type, date) 하나당 진행 상태 하나. 예: ("daily", "2026-08-19").
#
# 함수:
#   start(report_type, date, total_steps)   : 생성 시작 기록
#   update(report_type, date, label, step)  : 현재 단계 갱신 (label: "기기·하드웨어 오류" 등 사람이 읽는 이름)
#   finish(report_type, date)               : 완료 처리(상태 제거)
#   get_status(report_type, date)           : 현재 상태 조회. 진행 중 아니면 None
#   is_running(report_type, date)           : 진행 중 여부만 확인 (중복 시작 방지용)

_progress: dict[tuple[str, str], dict] = {}


def _key(report_type: str, date_str: str) -> tuple[str, str]:
    return (report_type, date_str)


def start(report_type: str, date_str: str, total_steps: int) -> None:
    _progress[_key(report_type, date_str)] = {
        "label": None,
        "step": 0,
        "total": total_steps,
    }


def update(report_type: str, date_str: str, label: str, step: int) -> None:
    entry = _progress.get(_key(report_type, date_str))
    if entry is None:
        return
    entry["label"] = label
    entry["step"] = step


def finish(report_type: str, date_str: str) -> None:
    _progress.pop(_key(report_type, date_str), None)


def get_status(report_type: str, date_str: str) -> dict | None:
    entry = _progress.get(_key(report_type, date_str))
    if entry is None:
        return None
    return {"running": True, **entry}


def is_running(report_type: str, date_str: str) -> bool:
    return _key(report_type, date_str) in _progress
