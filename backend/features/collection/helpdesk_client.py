# -*- coding: utf-8 -*-
# Helpdesk API HTTP 클라이언트. 쿠키 기반 세션 인증(XSRF-TOKEN + sessionid)으로 로그인한 뒤
# /issue/issues/ 엔드포인트에서 이슈를 수집한다.
# 사용 흐름: HelpdeskClient.login(id, pw) → 인스턴스 생성 → fetch_issues_since(last_id) → 정규화 dict 목록 반환.
# 이 클라이언트를 직접 호출하지 말고 scheduler.py(자동 수집) 또는 scripts/backfill_ids.py(보완)를 통해 사용한다.
#
# 조회 방식(2026-08 최종 승인): 시간 창이 아니라 id 커서 방식이다.
#   GET /issue/issues/?model_type=1009&id__gt={마지막 id}&order_by=id&limit=1000&results_only=true
# "마지막 id"는 별도로 저장하지 않고 우리 DB(issues 테이블)의 MAX(id)로 매번 구한다 — 이미 아는
# 정보라 중복 저장할 필요가 없다. 응답이 1000건 꽉 차면(공백이 길었던 경우) 마지막 id를 커서 삼아
# 이어서 요청해 누락 없이 전량을 받는다.
import httpx

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

    async def fetch_issues_since(self, last_id: int) -> list[dict]:
        """id가 last_id보다 큰 이슈를 승인된 커서 방식으로 가져와 정규화 dict 목록으로 반환한다.
        한 번에 최대 1000건까지 오며, 응답이 1000건 꽉 차면(공백이 길었던 경우) 이번에 받은
        최댓값을 커서 삼아 이어서 요청해 누락 없이 전량을 받는다.
        """
        all_issues: list[dict] = []
        cursor = last_id
        limit = 1000

        while True:
            resp = await self.client.get(
                f"{BASE_URL}/issue/issues/",
                params={
                    "model_type": 1009,
                    "id__gt": cursor,
                    "order_by": "id",
                    "limit": limit,
                    "results_only": "true",
                },
            )
            resp.raise_for_status()
            data = resp.json()
            results = data if isinstance(data, list) else data.get("results", [])
            if not results:
                break
            parsed = [self._parse_issue(r) for r in results]
            all_issues.extend(parsed)
            cursor = max(p["id"] for p in parsed)
            if len(results) < limit:
                break

        return all_issues

    async def close(self):
        await self.client.aclose()
