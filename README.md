# CS 대시보드

공감센터(help-desk) CS 데이터를 수집·분석하는 내부 대시보드.
매 시간 자동으로 데이터를 수집하고, 일별·주별·월별 통계와 분류별 드릴다운을 제공한다.

---

## 파일 구조

```
├── backend/
│   ├── server.py                      # 진입점: 라우터 등록·startup·SPA 폴백만
│   ├── core/
│   │   ├── db.py                          # DB 연결·스키마 초기화
│   │   └── date_bucket_utils.py           # 시간 버킷·기간 필터 공유 유틸
│   ├── features/
│   │   ├── stats/stats_endpoints.py       # GET /api/stats/* (9개)
│   │   ├── issues/
│   │   │   ├── issues_endpoints.py        # GET /api/issues
│   │   │   └── classifier.py              # 키워드 기반 CS 분류 로직
│   │   ├── insights/
│   │   │   ├── insights_endpoints.py      # GET·POST /api/insights/*
│   │   │   ├── insight_aggregations.py    # Wings 티켓·반복 인입 집계 계산
│   │   │   └── insights_cache.py          # 인사이트 DB 캐시 관리
│   │   └── collection/
│   │       ├── collection_endpoints.py    # GET /api/collection/latest
│   │       ├── scheduler.py               # 자동 수집 스케줄러
│   │       └── helpdesk_client.py         # help-desk API HTTP 클라이언트
│   ├── scripts/
│   │   ├── reclassify.py              # 전체 재분류 일괄 실행
│   │   └── backfill_ids.py            # student_id·parent_id 누락 보완
│   ├── helpdesk.db                    # SQLite DB
│   └── requirements.txt
├── frontend/                          # Vite + React + TypeScript
│   ├── src/
│   │   ├── main.tsx                   # 진입점
│   │   ├── App.tsx                    # 레이아웃·라우터
│   │   ├── index.css                  # 전역 스타일
│   │   ├── api/client.ts              # 백엔드 API 호출·타입 정의
│   │   ├── components/Sidebar.tsx
│   │   └── pages/
│   │       ├── dashboard/Dashboard.tsx
│   │       └── insights/
│   │           ├── WingsTickets.tsx
│   │           └── RepeatParents.tsx
│   └── dist/                          # 빌드 결과물 (FastAPI가 서빙)
├── .gitignore
└── CLAUDE.md                          # 개발 가이드 (분류 로직 상세 포함)
```

---

## 아키텍처

```
[help-desk API]
      │  자동 수집 (features/collection/scheduler.py)
      ▼
[SQLite DB]  ←  features/issues/classifier.py 로 call_memo 키워드 분류
      │
      ├─ 통계·이슈 API (features/stats, features/issues)
      │
      └─ 인사이트 캐시 (features/insights/insights_cache.py)
            └─ Wings 티켓 반복 인입 / 학부모 반복 인입 집계
      │
      ▼
[FastAPI]  →  [React SPA (frontend/dist)]
```

- 수집 주기: 매 정시 + 09:30~20:30 매 30분 / 자정엔 어제 누락 보정 + 인사이트 캐시 갱신
- 수집 규모: 약 800건/일
- 분류: `call_memo` 텍스트를 키워드로 매칭해 `new_category_main/sub` 결정
- 분류 로직 상세: `CLAUDE.md` 참고

---

## 설치 및 실행

**프론트엔드 빌드** (최초 1회 또는 변경 시)
```bash
cd frontend
npm install
npm run build
```

**백엔드 실행**
```bash
cd backend
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```

서버 시작 시 터미널에서 help-desk 아이디/비번 입력. 메모리에만 유지되며 파일에 저장되지 않는다.

---

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/stats/hourly_range` | 날짜 범위의 30분 버킷별 건수 |
| GET | `/api/stats/daily` | 일별 건수 |
| GET | `/api/stats/category` | 분류별 건수 (버킷·기간 필터 지원) |
| GET | `/api/stats/weekly` | 주차별 건수 (최근 4주) |
| GET | `/api/stats/monthly` | 월별 건수 (최근 3개월) |
| GET | `/api/issues` | 상세 목록 (드릴다운·페이지네이션) |
| GET | `/api/insights/wings_tickets` | 반복 Wings 티켓 캐시 조회 |
| GET | `/api/insights/repeat_parents` | 학부모 반복 인입 캐시 조회 |
| POST | `/api/insights/refresh` | 인사이트 즉시 재집계 |
| GET | `/api/collection/latest` | 마지막 수집 기록 |

공통 파라미터: `target_date`, `period` (day/week/month), `start_date`, `end_date`

---

## 인증

서버 시작 시 터미널에서 아이디/비번 입력 (`features/collection/scheduler.py`의 `prompt_credentials()`).
입력값은 메모리에만 유지되며 파일에 저장되지 않는다.
매 수집마다 `POST /account/auths/authenticate_new/`로 자동 로그인해서 토큰 갱신.

---

## DB 스키마

**issues 테이블**

| 컬럼 | 설명 |
|------|------|
| id | help-desk 원본 ID |
| created_date | 생성일시 (UTC, 조회 시 +9h 변환) |
| category_main | 원본 대분류 — **수정 금지** |
| category_sub | 원본 소분류 — **수정 금지** |
| category_full | 원본 전체 분류 경로 |
| call_memo | 상담 메모 |
| new_category_main | 재분류 대분류 (2026-06 키워드 분류) |
| student_id | 학생 ID (help-desk 원본) |
| parent_id | 학부모 ID (92는 내부 계정이므로 API 응답에서 NULL 처리) |
| new_category_main | 재분류 대분류 (2026-06 키워드 분류) |
| new_category_sub | 재분류 소분류 (2026-06 키워드 분류) |

`category_main/sub`는 help-desk 시스템에서 내려오는 원본값. 건드리지 않는다.
`new_category_main/sub`가 실제 분석에 사용하는 분류.

프론트엔드는 `new_category_main/sub` 기준으로 동작한다.

**collection_log 테이블**: 수집 이력 (일시, 대상일, 수집건수, 상태, 오류메시지)

**insights_cache 테이블**: 인사이트 집계 결과 캐시 (key, JSON data, updated_at). 무거운 집계 쿼리 결과를 보관하며, 서버 시작 시·POST /api/insights/refresh 호출 시·매일 자정에 갱신된다.

---

## 분류 시스템

call_memo 텍스트를 키워드로 매칭해 `new_category_main/sub`를 결정한다.

### 구성 요소

`backend/features/issues/classifier.py`에 세 가지 데이터 구조와 하나의 함수로 이루어져 있다.

#### 1. `SUB_TO_MAIN` — 소분류 → 대분류 매핑

소분류 이름을 키로 대분류를 값으로 갖는 dict. 소분류 26개, 대분류 9개.

| 대분류 | 소분류 |
|--------|--------|
| 해지·유지 상담 | 해지 확정, 해지 방어, 해지 상담, 해지금·위약금 문의 |
| 기기·하드웨어 오류 | 충전 불량, 터치·화면 불량, 전원·부팅 오류, 기기 파손, 기기 교체 요청 |
| 네트워크·앱 오류 | 와이파이 오류, 학습 끊김·멈춤, 앱 오류 |
| 미납·결제 | 미납 관리, 결제·환불 처리 |
| 체험 관련 | 체험 취소·미인지, 중복 신청, 체험 신청·로그인 독려 |
| 교재·물류·배송 | 누락·오배송, 기기 장기미회수, 배송·회수 처리 |
| 계정·서비스 | 개인정보 변경, 서비스·이벤트 문의 |
| 윙크북스 | 윙크북스, 구독취소 |
| 기타 | 교사 상담 요청, 기타 |

#### 2. `FALLBACK_SUBS` — 예비 소분류

```python
FALLBACK_SUBS = {"교사 상담 요청", "기타"}
```

- **일반 소분류**: 키워드가 매칭되면 항상 분류 결과로 사용됨
- **예비 소분류** (`FALLBACK_SUBS`에 등록된 것): 일반 소분류가 하나도 안 걸렸을 때만 사용됨

```
매칭된 소분류 목록
    └─ 일반 소분류가 있음 → 예비 소분류 전부 무시, 일반 소분류만 사용
    └─ 일반 소분류가 없음 → 예비 소분류 사용
```

예: 메모에 "선생님 전달" + "해지요청" 둘 다 포함
→ `교사 상담 요청`(예비), `해지 상담`(일반) 둘 다 매칭됨
→ 일반 소분류가 있으므로 `교사 상담 요청` 무시
→ 최종: `해지·유지 상담 / 해지 상담`

#### 3. `RULES` — 키워드 규칙 리스트 (순서 있음)

`(소분류명, [키워드, ...])` 형태의 리스트. **리스트 순서가 우선순위**가 된다.
각 소분류에서 키워드는 `in` 연산자로 부분 일치 확인. 키워드 전체 목록은 `classifier.py`의 `RULES`가 정본이다.

#### 4. `classify(memo)` — 분류 실행 함수

`call_memo` 문자열을 받아 `(대분류, 소분류)` 튜플을 반환한다. 미분류 시 `(None, None)`.

```
1. memo가 비어 있으면 → (None, None) 반환
2. RULES를 순서대로 순회 → 키워드 매칭된 소분류 수집
3. matched_subs가 없으면 → (None, None) 반환
4. 폴백 분리: non_fallback이 있으면 폴백 무시, 없으면 폴백 사용
5. 대분류 그룹화: SUB_TO_MAIN으로 변환
6. 대분류가 1개 → 해당 (대분류, 소분류) 반환
7. 대분류가 2개 이상 → 우선순위 순서로 선택
   기타 → 해지·유지 상담 → 네트워크·앱 오류 → 기기·하드웨어 오류
   → 미납·결제 → 체험 관련 → 교재·물류·배송 → 계정·서비스 → 윙크북스
8. caller(scheduler.py)에서 (None, None) 수신 시 기타/기타로 DB에 저장
```

### 분류 규칙 변경

분류 규칙을 변경하면 DB 전체 재적용이 필요하다. 전체 `issues` 레코드에 대해 `classify(call_memo)`를 다시 실행하고 `new_category_main/sub`를 UPDATE한다.

---

## 외부 API 호출 명세

> 우리 서버는 외부 시스템의 DB를 직접 건드리지 않는다. **HTTP API(읽기 GET) 호출**로만 데이터를 받아
> **우리 로컬 SQLite(helpdesk.db)** 에만 저장한다.

### 공통 요청 헤더 (help-desk)

```
accept: */*
accept-language: ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7
origin: https://help-desk.wink.co.kr
referer: https://help-desk.wink.co.kr/
user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36
```

### ① help-desk 로그인 (POST)

```
POST https://help-desk-api.wink.co.kr/account/auths/authenticate_new/
Content-Type: application/json
(공통 헤더)

Body: {"username": "<아이디>", "password": "<비밀번호>"}
```

**요청 본문(JSON body) — GET 쿼리 아님(민감정보라 본문에 담음)**

| 필드 | 설명 |
|------|------|
| username | help-desk 아이디 (서버 시작 시 1회 입력, 메모리 보관) |
| password | 비밀번호 |

**응답**: `Set-Cookie: XSRF-TOKEN=...; sessionid=...` → 이후 요청 인증에 사용(+`x-csrftoken` 헤더)

### ② help-desk 이슈 조회 (GET)

```
GET https://help-desk-api.wink.co.kr/issue/issues/?model_type=1009&is_complete=true&limit=100&offset=0&created_date=2026-06-12,2026-06-12&search=&order_by=-dpo,-id
x-csrftoken: <XSRF-TOKEN>
Cookie: XSRF-TOKEN=<...>; sessionid=<...>
(공통 헤더)
```

**요청 쿼리 파라미터 (URL `?` 뒤)**

| 파라미터 | 값/예시 | 설명 |
|----------|---------|------|
| model_type | 1009 | 이슈 모델 타입 (고정) |
| is_complete | true | 완료된 이슈만 조회 |
| limit | 100 | 페이지당 건수 (최대 100) |
| offset | 0, 100, 200 … | 페이지 시작 위치 (`next` 없을 때까지 100씩 증가) |
| created_date | `2026-06-12,2026-06-12` | 조회 기간 `시작,끝` (같은 날이면 하루치) |
| search | (빈값) | 검색어 |
| order_by | -dpo,-id | 정렬 (dpo 내림차순, id 내림차순) |

**응답** `{ "results": [ ... ], "next": "..." }` — 이슈 1건에서 쓰는 필드:

| 응답 필드 | 저장 컬럼 | 분석 사용 |
|-----------|-----------|-----------|
| id | id | ✅ 키·중복제거·증분 |
| created_date | created_date | ✅ 날짜/통계 (UTC, +9h 변환) |
| complete_date | complete_date | ❌ 저장만 |
| category_tag | category_tag | ❌ 저장만 |
| data.category_tag_full_name | category_main/sub/full | △ 원본 보존(정책1), 분석엔 미사용 |
| data.call_history.call_memo | call_memo | ✅ 분류·표시 |
| student | student_id | ✅ 어드민 링크 |
| parent | parent_id | ✅ 반복 학부모·링크 |

> 응답은 이슈 객체 전체가 오므로, 일부만 저장해도 호출/대역폭은 동일하다.

### ③ Wings 티켓 상태 (GET)

```
GET https://wings.danbiedu.co.kr/api/v1/tickets/<티켓ID>
Authorization: Token token=<wings_token>
```

**응답**: `{ "state_id": <int>, ... }` → 한국어 상태 매핑

| state_id | 상태 |
|----------|------|
| 1 | 신규 |
| 2 | 진행 중 |
| 4 | 해결 |
| 5 | merged |
| 7 | 요청취소 |
| 8 | 결과 확인 중 |

자정(또는 수동 새로고침) 시 반복 Wings 티켓 수만큼 병렬 호출.

### ④ admin 가입일 (GET) — 제안·미통합(0회)

```
GET https://admin-api.wink.co.kr/account/actors/<parent_id>/
(인증 방식 미확인 — 세션 쿠키 or 토큰)
```

**응답** (주요 필드):

| 응답 필드 | 설명 |
|-----------|------|
| id | actor ID (우리 `parent_id`와 동일로 추정) |
| created_date | **가입일** (코호트 분석용) |
| auth_human_name | 학부모 이름 |
| category_tag_name | 구분(엄마/아빠 등) |

코호트 분석용. 통합 시 "수집할 때 신규 parent만 1회 조회 후 캐시" 방식 권장. 목록 API(`/account/actors/?limit=1000`) 존재 시 페이지 단위로 일괄 수집 가능.

### 수집 스케줄 & 호출 횟수

- **스케줄**: 업무시간(09:00~20:30) 30분 간격(24회) + 자정 00:00 1회 = **하루 25회 실행**
  - `09:00` 실행이 00~09시 신규분을, 자정 실행이 전날 21~24시 신규분을 증분으로 채움
  - `01~08시`엔 호출 없음 (새벽 CS 거의 0 → 09:00에 일괄 수집)
- **증분 수집**: 최신순으로 받다가 기존 ID만 나오는 페이지에서 멈춤 → 1회 실행당 보통 이슈 페이지 1콜
- **세션 재사용**: 서버 시작 시 1회 로그인, 이후 재사용. 401/403 응답 시에만 재로그인
- **자정 전량 보정**: 어제치를 통째로 재조회(~8페이지)해 사후 수정(메모·완료일·분류 변경) 반영

**하루 호출 합계 (수집 ON 기준):**

| 항목 | 횟수 |
|---|---|
| ① 로그인 | ~1 (세션 재사용) |
| ② 이슈 페이지 | ~33 (증분 25회×1 + 자정 전량 ~8) |
| ③ Wings | 자정 1회 × 반복 티켓 수 |
| ④ admin 가입일 | 0 (미통합) |
| **help-desk 소계** | **~34** |

(증분·세션재사용·스케줄 조정 전에는 ~240콜이었음)

### 중단 스위치

`features/collection/scheduler.py`의 `COLLECTION_ENABLED` 플래그로 외부 API 호출을 전면 제어한다.
- `False`(현재): 자동 수집·Wings 조회 일절 안 함, 자격증명 입력도 스킵. 대시보드는 기존 DB로 정상 동작.
- `True`: 위 스케줄대로 수집 재개. 변경 후 **서버 재시작 필요**.

---

## 과거 데이터 백필 (6개월치) — 예정

현재 DB는 약 4주치(2026-05-15~)만 보유. 6개월치(~10만건)를 끌어오면 이탈 여정·CS 예보 등
긴 시간축 인사이트가 가능해진다. **단 아래 안전 수칙을 지켜 실행한다.**

### ⚠️ 리스크

- `help-desk-api.wink.co.kr`는 **CS 상담원이 실시간으로 쓰는 운영 API**다. 대량 스크랩이 상담
  트래픽과 경쟁하면 운영 서버가 느려지거나 장애가 날 수 있다.
- 현재 `helpdesk_client.py`의 `fetch_issues`는 **페이지 호출 사이 딜레이가 없다**. 10만건 = 약 1,000회
  요청을 텀 없이 쏟아붓는 구조라 그대로 쓰면 위험하다.
- 읽기 전용 GET이라 help-desk 데이터를 변경하진 않지만, 한 직원 계정으로 자동 트래픽을 많이
  보내면 **이상탐지·계정 잠금** 위험이 있다.

### ✅ 안전 실행 수칙

1. **오프피크 실행** — 스케줄러가 09:30~20:30 동작하므로 **밤 20:30 이후 ~ 09:00 사이**에 돌린다.
2. **페이지 간 딜레이 2~5초** 삽입 (`scripts/backfill_ids.py`의 `DELAY=5` 패턴 참고).
   2초×1,000 ≈ 33분, 5초면 ~83분 소요.
3. **세션 1회 로그인 재사용** — 날짜마다 재로그인하지 않는다.
4. **날짜 청크 단위**로 끊어 중단·재개 가능하게 만든다.
5. 백필 후 분류 규칙이 바뀐 게 있으면 **전체 재분류**(`scripts/reclassify.py`) 실행.

### 실행 후 가능해지는 인사이트

- **이탈 여정 (G)**: 수주~수개월에 걸친 카테고리 흐름 추적. 단 "오류→해지" 인과는 4주
  데이터에서 반대로 나왔으므로(기술오류 고객이 해지 덜함) **6개월 데이터로 재검증 후 설계**.
- **CS 예보 (R)**: 8주 이상 이력 기반 기대 범위·이상 감지.
- ※ "해지 상담"은 6개월이어도 실제 해지가 아닌 *상담 접수*임에 유의.

---

## 미구현 항목

- **Teams 알림**: 임계값 기반 이상 감지 알림
- **LLM 보고서**: Ollama 기반 자동 보고서 생성
- **데이터 필터링**: 불필요 분류 제거 (분류 안정화 후 결정)
- **CS 예보 (R)**: CS 급증 이상감지. "배포가 원인"까지 엮으려면 배포 일자 데이터 필요 → **보류** (배포 일자 확보 후 진행)
