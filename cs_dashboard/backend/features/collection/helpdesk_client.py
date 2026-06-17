# -*- coding: utf-8 -*-
# Helpdesk API HTTP 클라이언트. 쿠키 기반 세션 인증(XSRF-TOKEN + sessionid)으로 로그인한 뒤
# /issue/issues/ 엔드포인트를 100건씩 페이지네이션하며 완료 이슈 전체를 수집한다.
# 사용 흐름: HelpdeskClient.login(id, pw) → 인스턴스 생성 → fetch_issues(date) → 정규화 dict 목록 반환.
# 이 클라이언트를 직접 호출하지 말고 scheduler.py(자동 수집) 또는 scripts/backfill_ids.py(보완)를 통해 사용한다.
import httpx
from datetime import date

BASE_URL = "https://help-desk-api.wink.co.kr"
HEADERS = {
    "accept": "*/*",
    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "origin": "https://help-desk.wink.co.kr",
    "referer": "https://help-desk.wink.co.kr/",
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/148.0.0.0 Safari/537.36"
    ),
}


def select_new_issues(parsed: list[dict], known_ids: set) -> list[dict]:
    """정규화된 한 페이지 결과에서 known_ids에 없는 신규 이슈만 골라 반환한다 (증분 수집용 순수 함수).
    반환이 빈 리스트면 호출부(fetch_issues)는 그 페이지가 전부 기존 ID라 보고 페이지네이션을 멈춘다."""
    return [p for p in parsed if p["id"] not in known_ids]


class HelpdeskClient:
    def __init__(self, xsrf_token: str, session: str):
        self.client = httpx.AsyncClient(
            headers={**HEADERS, "x-csrftoken": xsrf_token},
            cookies={"XSRF-TOKEN": xsrf_token, "sessionid": session},
            timeout=30,
        )

    @classmethod
    async def login(cls, username: str, password: str) -> "HelpdeskClient":
        async with httpx.AsyncClient(headers=HEADERS, timeout=30) as client:
            resp = await client.post(
                f"{BASE_URL}/account/auths/authenticate_new/",
                json={"username": username, "password": password},
            )
            resp.raise_for_status()
            xsrf = resp.cookies.get("XSRF-TOKEN", "")
            session = resp.cookies.get("sessionid", "")
        return cls(xsrf_token=xsrf, session=session)

    def _parse_issue(self, raw: dict) -> dict:
        data = raw.get("data") or {}
        full_name = data.get("category_tag_full_name", "") or ""
        parts = [p.strip() for p in full_name.split(" / ") if p.strip()]
        call_memo = (data.get("call_history") or {}).get("call_memo", "") or ""
        return {
            "id": raw["id"],
            "created_date": raw.get("created_date"),
            "complete_date": raw.get("complete_date"),
            "category_tag": raw.get("category_tag"),
            "category_main": parts[0] if parts else None,
            "category_sub": parts[-1] if len(parts) > 1 else parts[0] if parts else None,
            "category_full": full_name,
            "call_memo": call_memo,
            "student_id": raw.get("student"),
            "parent_id": raw.get("parent"),
        }

    async def fetch_issues(self, target_date: date, known_ids: set | None = None) -> list[dict]:
        """target_date(하루)의 완료 이슈를 100건씩 페이지네이션해 정규화 dict 목록으로 반환한다.

        known_ids 지정 시 '증분 모드': 결과를 최신순(-id)으로 받다가 한 페이지가 전부 기존 ID면
        더 받지 않고 멈춘다(신규분만 수집). known_ids=None이면 그날 전체를 재조회한다(전량/보정용).
        주의: 증분 모드는 이미 수집된 이슈의 사후 수정(메모·완료일 변경)은 반영하지 못한다.
        """
        date_str = target_date.strftime("%Y-%m-%d")
        all_issues = []
        offset = 0
        limit = 100

        while True:
            resp = await self.client.get(
                f"{BASE_URL}/issue/issues/",
                params={
                    "model_type": 1009,
                    "is_complete": "true",
                    "limit": limit,
                    "offset": offset,
                    "created_date": f"{date_str},{date_str}",
                    "search": "",
                    "order_by": "-dpo,-id",
                },
            )
            resp.raise_for_status()
            data = resp.json()
            results = data.get("results", [])
            if not results:
                break
            parsed = [self._parse_issue(r) for r in results]
            if known_ids is not None:
                new = select_new_issues(parsed, known_ids)
                all_issues.extend(new)
                if not new:  # 이 페이지가 전부 기존 ID → 이후 페이지는 더 오래된 것뿐
                    break
            else:
                all_issues.extend(parsed)
            if not data.get("next"):
                break
            offset += limit

        return all_issues

    async def close(self):
        await self.client.aclose()
