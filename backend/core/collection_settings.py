# -*- coding: utf-8 -*-
# CS 상담 수집 API 호출 on/off 상태를 저장·조회한다.
# core/gemma_client.py의 URL 설정과 동일한 패턴: 메모리 값 + collection_settings.json 파일로
# 서버 재시작 후에도 값이 유지된다.
# 기본값은 False(중단) — 회사 승인 전까지는 파일이 없어도 절대 호출하지 않기 위한 안전장치.
import json
from pathlib import Path

_SETTINGS_FILE = Path(__file__).parent.parent / "collection_settings.json"


def _load_saved_enabled() -> bool:
    try:
        data = json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
        return bool(data.get("enabled", False))
    except Exception:
        return False


_enabled: bool = _load_saved_enabled()


def get_collection_enabled() -> bool:
    return _enabled


def set_collection_enabled(value: bool) -> None:
    global _enabled
    _enabled = value
    _SETTINGS_FILE.write_text(json.dumps({"enabled": value}), encoding="utf-8")
