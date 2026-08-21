# CS 대시보드

공감센터(help-desk) CS 데이터를 수집·분석하는 내부 대시보드.
CS 업무시간 동안 5분 간격으로 데이터를 자동 수집하고, 일별·주별 통계, 분류별 드릴다운,
Gemma AI 기반 보고서, 이탈·교체 원인 분석 등을 제공한다.

---

## 파일 구조

```
├── backend/
│   ├── Dockerfile                         # 백엔드 컨테이너 빌드 정의
│   ├── .dockerignore                      # .env·helpdesk.db·로그 등 이미지에서 제외
│   ├── server.py                          # 진입점: 라우터 등록·startup·SPA 폴백만
│   ├── requirements.txt
│   ├── helpdesk.db                        # SQLite DB
│   ├── core/
│   │   ├── db.py                              # DB 연결·스키마 초기화 (정책 3: get_conn()만 사용)
│   │   ├── date_bucket_utils.py               # 시간 버킷·기간 필터 공유 유틸
│   │   ├── holidays.py                        # 영업일(주말·공휴일 제외) 판단 유틸
│   │   ├── gemma_client.py                    # Gemma API 호출 공용 유틸 (서버 URL·모델명·JSON 추출)
│   │   ├── collection_settings.py             # CS 수집 API 호출 on/off 상태 (collection_settings.json)
│   │   └── audit_log.py                       # 감사 로그 기록·조회
│   ├── features/
│   │   ├── stats/stats_endpoints.py           # GET /api/stats/* (10개)
│   │   ├── issues/
│   │   │   ├── issues_endpoints.py            # GET /api/issues, /api/issues/subs
│   │   │   ├── classifier.py                  # 키워드 기반 CS 분류 엔진 (RULES 정본)
│   │   │   ├── churn_device_insights.py       # 해지 사유·기기 교체 원인 집계
│   │   │   └── retention_insights.py          # 해지 방어 성공률·리텐션 오퍼 집계
│   │   ├── insights/
│   │   │   ├── insights_endpoints.py          # GET·POST /api/insights/* (6개)
│   │   │   ├── insight_aggregations.py        # Wings 티켓·반복 학부모 인입 집계
│   │   │   └── insights_cache.py              # 인사이트 DB 캐시 관리
│   │   ├── collection/
│   │   │   ├── collection_endpoints.py        # GET/POST /api/collection/* (6개)
│   │   │   ├── scheduler.py                   # 자동 수집·보고서 생성 스케줄러 (등록은 _register_jobs()만 보면 됨)
│   │   │   └── helpdesk_client.py             # help-desk API HTTP 클라이언트 (id 커서 기반 수집)
│   │   ├── report/
│   │   │   ├── report_endpoints.py            # GET·POST /api/report/* (일별·주간, 11개)
│   │   │   ├── report_daily.py                # 일별 보고서 생성·Gemma 카테고리 분석
│   │   │   ├── report_weekly.py               # 주간 보고서 생성·Gemma 카테고리·요약 분석
│   │   │   └── report_utils.py                # 리스크 카테고리 정의·Gemma 공통 프롬프트
│   │   ├── jira/
│   │   │   ├── jira_endpoints.py              # GET·POST /api/jira/* (3개)
│   │   │   └── jira_client.py                 # JIRA API 클라이언트 (미해결 버그 조회)
│   │   ├── settings/settings_endpoints.py     # GET·POST /api/settings/gemma
│   │   └── admin/
│   │       ├── admin_endpoints.py             # POST /api/admin/verify, require_admin 의존성
│   │       └── audit_endpoints.py             # GET /api/audit/log
│   └── scripts/
│       ├── reclassify.py                  # 전체 재분류 일괄 실행 (분류 규칙 변경 시 필수)
│       ├── backfill_ids.py                # student_id·parent_id 누락 보완
│       ├── backfill_keyword_cache.py      # 과거 날짜별 keyword_trend 캐시 일괄 생성
│       └── import_backfill_csv.py         # 플랫폼엔지니어링팀 제공 CSV로 과거 데이터 백필
├── frontend/                              # Vite + React + TypeScript
│   ├── Dockerfile                         # 프론트 컨테이너 빌드 정의 (멀티스테이지: npm build → nginx)
│   ├── nginx.conf                         # 정적 서빙 + /api 프록시 (같은 오리진이라 CORS 불필요)
│   ├── .dockerignore
│   └── src/
│       ├── main.tsx                       # 진입점
│       ├── App.tsx                        # 레이아웃·라우터 (정책 7: 순수 라우터)
│       ├── index.css                      # 전역 스타일 (qi-* 클래스: 모던 리치 인사이트 디자인)
│       ├── api/
│       │   ├── client.ts                  # 백엔드 API 호출·타입 정의 (정책 9: 모든 fetch는 여기만)
│       │   └── categories.ts              # 리스크 분류 허용 기준·필터 트리
│       ├── hooks/useAdmin.ts              # 관리자 모드 상태·토큰 관리
│       ├── components/
│       │   ├── Sidebar.tsx                # 좌측 네비게이션 (인사이트 서브메뉴, 관리자 전용 섹션)
│       │   ├── Badge.tsx                  # 공용 알약형 라벨 뱃지
│       │   └── CategoryMemoModal.tsx      # 대분류별 CS 메모 목록 모달 (여러 페이지가 재사용)
│       └── pages/
│           ├── dashboard/
│           │   ├── StrategicDashboard.tsx     # 전략 대시보드(홈) — 팀장·상급자 보고용 주간 브리핑
│           │   └── Dashboard.tsx              # 운영 현황
│           ├── report/
│           │   ├── DailyReport.tsx            # 일별 보고서 (Gemma 카테고리·피크타임 분석)
│           │   └── WeeklyReport.tsx           # 주간 보고서 (Gemma 카테고리·요약 분석)
│           ├── insights/
│           │   ├── ServiceQualityIndex.tsx    # 서비스 품질 지수
│           │   ├── WingsTickets.tsx           # 반복 Wings 티켓
│           │   ├── RepeatParents.tsx          # 학부모 반복 인입
│           │   ├── KeywordTrend.tsx           # 이슈 후보 탐지 (키워드 급증)
│           │   ├── JiraBugs.tsx               # 방치된 JIRA 버그 × CS 연관 분석
│           │   ├── ChurnReasonInsight.tsx     # 해지 사유 분석
│           │   ├── DeviceSwapInsight.tsx      # 기기 교체 분석
│           │   └── RetentionInsight.tsx       # 해지 방어 성과
│           └── admin/                         # 관리자 전용 (사이드바 하단 🔒으로 진입)
│               ├── InsightRoadmap.tsx         # 인사이트 로드맵
│               ├── ApiConsole.tsx             # CS 수집 API 관리·모니터링
│               └── AuditLog.tsx               # 감사 로그
├── docker-compose.yml                     # backend+frontend 컨테이너 통합 실행
├── .gitignore
└── CLAUDE.md                              # 개발 가이드 (정책·분류 로직 상세 포함)
```

---

## 아키텍처

```
[help-desk API] ──(id 커서 기반, 09:00~21:00 5분 간격+보정, 최대 146회/일)──▶ [SQLite DB]
                                                                                  │
                                                          features/issues/classifier.py
                                                          로 call_memo 키워드 분류
                                                                                  │
                    ┌─────────────────────────────┬───────────────────┼──────────────────────┐
                    ▼                             ▼                   ▼                      ▼
            통계·이슈 API                  인사이트 캐시           일별·주간 보고서         감사 로그
      (features/stats, issues)      (features/insights,     (features/report,        (core/audit_log —
                                      churn_device_insights,   Gemma AI 카테고리·        수동/자동 조작 이력,
                                      retention_insights)       요약 분석)                수집 틱 제외)
                    │                             │                   │                      │
                    └─────────────────────────────┴───────────────────┴──────────────────────┘
                                                        ▼
                                              [FastAPI] ── /api/* ──▶ [React SPA]
                                              (로컬: FastAPI가 dist/ 직접 서빙
                                               Docker: nginx가 서빙 + /api를 backend로 프록시)

[관리자 모드] 공유 암호 1개 → 서버가 무작위 세션 토큰 발급 (계정 시스템 없음, features/admin)
```

- **수집 스케줄**: 09:00 아침보정 → 09:05~20:55 5분 간격 정기 → 21:00 마지막 정기 → 00:00 심야보정 (하루 최대 146회, 승인된 호출 빈도)
- **수집 방식**: 시간창 조회가 아니라 마지막으로 받은 `id` 이후만 받는 커서 방식 (`id__gt`) — 누락·중복 위험이 낮다
- **보고서 자동 생성**: 매일 00:30(전날 일별 보고서), 매주 월요일 00:30(직전 주 주간 보고서), 매일 08:00(키워드 트렌드 캐시)
- **분류**: `call_memo` 텍스트를 키워드로 매칭해 `new_category_main/sub` 결정
- **AI 분석**: Gemma(`core/gemma_client.py`)가 카테고리별 리스크 요약·주간 총평 생성. 실패 시 사유가 `gemma_error`로 남아 보고서 화면·감사 로그에서 확인 가능
- 분류 로직 상세: `CLAUDE.md` 참고

---

## 설치 및 실행

### 로컬 개발

**프론트엔드**
```bash
cd frontend
npm install
npm run dev      # 개발 서버 (vite, /api는 localhost:8000으로 프록시)
npm run build    # 프로덕션 빌드 (dist/를 백엔드가 서빙)
```

**백엔드**
```bash
cd backend
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```

`backend/.env`에 필요한 값(`ADMIN_PASSCODE`, `HELPDESK_USERNAME`/`HELPDESK_PASSWORD`, `WINGS_TOKEN`, `JIRA_EMAIL`/`JIRA_TOKEN`, `GEMMA_BASE_URL` 등)을 채워야 한다. `.env`는 git에 올리지 않는다(`.gitignore` 처리됨).

### Docker

```bash
docker compose up --build -d
```

`backend/.env`를 그대로 읽어서 컨테이너에 주입하며, 이미지 안에는 `.env`가 들어가지 않는다(`backend/.dockerignore`). `helpdesk.db`는 호스트 파일을 그대로 볼륨 마운트해서 컨테이너를 재빌드해도 데이터가 유지된다.

기본 접속 포트는 `8092`(frontend 컨테이너가 서빙, `/api/*`는 nginx가 backend 컨테이너로 프록시 — 오리진이 하나라 CORS 설정 불필요). 다른 포트를 쓰려면 `FRONTEND_PORT` 환경변수로 지정한다. 내부망 전용 배포 기준이라 HTTPS는 이 구성에 포함하지 않는다 — 외부 노출이 필요해지면 그때 리버스 프록시를 앞단에 추가한다.

---

## API 엔드포인트

**통계** (`features/stats`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/stats/hourly_range` | 날짜 범위의 30분 버킷별 건수 |
| GET | `/api/stats/daily` | 일별 건수 |
| GET | `/api/stats/category` | 분류별 건수 (버킷·기간 필터 지원) |
| GET | `/api/stats/weekly` | 주차별 건수 (최근 4주) |
| GET | `/api/stats/monthly` | 월별 건수 (최근 3개월) |
| GET | `/api/stats/category_daily` | 일별 보고서용 카테고리별 당일 건수 |
| GET | `/api/stats/keyword_trend` | 키워드 급증 탐지 (이슈 후보) |
| GET | `/api/stats/keyword_memos` | 특정 키워드의 당일 메모 목록 |
| GET | `/api/stats/keyword_history` | 키워드별 최근 N일 이력 |
| GET | `/api/stats/keyword_trend_dates` | 키워드가 탐지된 날짜 목록 |

**이슈** (`features/issues`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/issues` | 상세 목록 (드릴다운·페이지네이션) |
| GET | `/api/issues/subs` | 대분류 내 소분류 건수 목록 |

**인사이트** (`features/insights`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/insights/wings_tickets` | 반복 Wings 티켓 캐시 조회 |
| GET | `/api/insights/repeat_parents` | 학부모 반복 인입 캐시 조회 |
| POST | `/api/insights/refresh` | 인사이트 즉시 재집계 |
| GET | `/api/insights/churn_reasons` | 해지 사유별 집계 (사유 필드 있는 건만) |
| GET | `/api/insights/device_swaps` | 기기 교체 요청 기종·선출고 여부 집계 |
| GET | `/api/insights/retention` | 해지 방어 성공률·리텐션 오퍼별 집계 |

**수집** (`features/collection`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/collection/latest` | 마지막 수집 기록 |
| GET | `/api/collection/daily_counts` | 일자별 수집 호출 횟수 |
| GET | `/api/collection/log` | 수집 호출 상세 로그 |
| GET | `/api/collection/log/{log_id}/issues` | 특정 호출로 받은 이슈 목록 복원 |
| GET | `/api/collection/status` | 수집 on/off 상태 조회 |
| POST | `/api/collection/enabled` | 수집 on/off 전환 (관리자 전용) |

**보고서** (`features/report`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/report/daily` | 일별 보고서 조회 |
| POST | `/api/report/daily/generate-stats` | 일별 통계 재생성 |
| POST | `/api/report/daily/analyze-category` | 카테고리 1건 Gemma 분석 |
| POST | `/api/report/daily/analyze-peak` | 피크타임 버킷 Gemma 분석 |
| GET | `/api/report/weekly/latest` | 최근 주간 보고서 조회 |
| GET | `/api/report/weekly` | 특정 주 보고서 조회 |
| POST | `/api/report/weekly/generate-stats` | 주간 통계 재생성 |
| POST | `/api/report/weekly/generate` | 주간 보고서 전체 생성 |
| POST | `/api/report/weekly/analyze-category` | 카테고리 1건 Gemma 분석 |
| POST | `/api/report/weekly/analyze-summary` | 주간 총평 Gemma 분석 |
| GET | `/api/report/weekly/memos` | 주간 리스크 카테고리 메모 목록 |

**JIRA** (`features/jira`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/jira/bugs` | 미해결 버그 × CS 연관 건수 (캐시 60분) |
| GET | `/api/jira/bugs/{key}/memos` | 특정 버그에 연관된 CS 메모 |
| POST | `/api/jira/sync` | JIRA 이슈 즉시 재동기화 |

**설정·관리자** (`features/settings`, `features/admin`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/settings/gemma` | Gemma 서버 URL·프리셋 목록 조회 |
| POST | `/api/settings/gemma` | Gemma 서버 URL 변경 |
| POST | `/api/admin/verify` | 관리자 암호 확인 → 세션 토큰 발급 |
| GET | `/api/audit/log` | 감사 로그 조회 (관리자 전용) |

공통 파라미터: `target_date`, `period` (day/week/month), `start_date`, `end_date`

---

## 인증

**관리자 모드** (`features/admin`) — 계정·로그인 시스템 없이 부서 공유 암호 하나로 "관리자인지"만 확인한다.
프론트에서 암호를 입력하면 `POST /api/admin/verify`가 `.env`의 `ADMIN_PASSCODE`와 비교해 맞으면 무작위 세션 토큰을 발급한다. 실제 암호는 프론트(localStorage)에 남기지 않고 토큰만 저장하며, 토큰은 서버 메모리에만 있어 서버 재시작 시 전부 무효화된다. 다른 관리자 전용 엔드포인트는 `require_admin` 의존성으로 헤더의 `X-Admin-Token`을 검사한다.

**help-desk API 인증** — `.env`의 `HELPDESK_USERNAME`/`HELPDESK_PASSWORD`로 서버 시작 시 로그인해 세션(`XSRF-TOKEN`+`sessionid`)을 받고, 이후 계속 재사용한다. 401/403 응답을 받을 때만 재로그인한다. 사람이 지켜보지 않는 서버 환경(Docker 등)에서도 자동 기동할 수 있도록 대화형 입력이 아닌 환경변수를 쓴다.

---

## DB 스키마

**issues 테이블** — CS 상담 원본·분류 데이터

| 컬럼 | 설명 |
|------|------|
| id | help-desk 원본 ID |
| created_date | 생성일시 (UTC, 조회 시 +9h 변환) |
| category_main / category_sub / category_full | 원본 분류 — **수정 금지** (정책 1) |
| call_memo | 상담 메모 |
| new_category_main / new_category_sub | 재분류 결과 (`classifier.py` 키워드 분류, 실제 분석에 사용) |
| student_id | 학생 ID (help-desk 원본) |
| parent_id | 학부모 ID (내부 테스트 계정은 API 응답에서 NULL 처리) |

`category_main/sub`는 help-desk 시스템에서 내려오는 원본값. 건드리지 않는다.
`new_category_main/sub`가 실제 분석에 사용하는 분류이며, 프론트엔드는 이 값 기준으로 동작한다.

**collection_log 테이블**: 수집 호출 이력. `collected_at`(호출 시각), `date_target`, `count_fetched`, `status`, `message`, `last_id`/`end_id`(이 호출이 받은 id 구간 — 관리자 페이지에서 정확한 이슈 목록 복원에 사용), `source`(정기/아침보정/심야보정/서버시작/수동 라벨)

**insights_cache 테이블**: 무거운 집계 쿼리 결과 캐시. `key`, `data`(JSON), `updated_at`. 서버 시작 시·`POST /api/insights/refresh` 호출 시·매일 자정에 갱신

**jira_issues 테이블**: JIRA 미해결 버그 캐시. `key`, `summary`, `status`, `created_at`, `cs_keywords`, `cs_count`, `synced_at`

**reports 테이블**: 일별·주간 보고서 저장. `report_date`(PK), `report_type`(daily/weekly), `content`(JSON — Gemma 분석 결과·`gemma_error` 포함), `generated_at`

**audit_log 테이블**: 관리자 조작·자동 작업 이력. `created_at`, `action`, `detail`, `mode`(manual/auto). 단순 조회(GET)와 5분마다 도는 CS 수집 틱은 제외 (수집은 `collection_log`가 이미 커버)

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
| 기기·하드웨어 오류 | 충전·전원 불량, 터치·입력 불량, 부팅 오류, 기기 파손, 기기 교체 요청 |
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

`extract_symptom_fields()`가 RULES 매칭 전에 템플릿 메모(`*확인사항 :`, `점검 요청 내용 :` 등)에서 실제 증상 텍스트만 뽑아내고, `*후속관리 :` 같은 boilerplate 라벨은 `_META_FIELD` 정규식으로 지운다 — 단 `*해지요청 사유` 필드는 값 안에 분류에 필요한 실제 사유가 들어있어 예외적으로 보존한다.

#### 4. `classify(memo)` — 분류 실행 함수

`call_memo` 문자열을 받아 `(대분류, 소분류)` 튜플을 반환한다. 미분류 시 `(None, None)`.

```
1. memo가 비어 있으면 → (None, None) 반환
2. *교체학습기/*교체 학습기 헤더가 있으면 → 바로 (기기·하드웨어 오류, 기기 교체 요청) 확정
3. extract_symptom_fields()로 증상 텍스트만 추출
4. RULES를 순서대로 순회 → 키워드 매칭된 소분류 수집
5. matched_subs가 없으면 → (None, None) 반환
6. 폴백 분리: non_fallback이 있으면 폴백 무시, 없으면 폴백 사용
7. 대분류 그룹화: SUB_TO_MAIN으로 변환
8. 대분류가 1개 → 해당 (대분류, 소분류) 반환
9. 대분류가 2개 이상 → 우선순위 순서로 선택
   기타 → 해지·유지 상담 → 네트워크·앱 오류 → 기기·하드웨어 오류
   → 미납·결제 → 체험 관련 → 교재·물류·배송 → 계정·서비스 → 윙크북스
10. caller(scheduler.py)에서 (None, None) 수신 시 기타/기타로 DB에 저장
```

### 분류 규칙 변경

분류 규칙을 변경하면 DB 전체 재적용이 필요하다. `python scripts/reclassify.py`로 전체 `issues` 레코드에 대해 `classify(call_memo)`를 다시 실행하고 `new_category_main/sub`를 UPDATE한다. 변경 규모가 크면(여러 키워드 동시 삭제 등) 예상 못 한 회귀가 섞여 나올 수 있으니, 재분류 전후로 실제 건수 변화를 카테고리별로 확인하는 걸 권장한다.

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

| 필드 | 설명 |
|------|------|
| username | help-desk 아이디 (`.env`의 `HELPDESK_USERNAME`) |
| password | 비밀번호 (`.env`의 `HELPDESK_PASSWORD`) |

**응답**: `Set-Cookie: XSRF-TOKEN=...; sessionid=...` → 이후 요청 인증에 사용(+`x-csrftoken` 헤더). 서버 시작 시 1회 로그인해 재사용하고, 401/403 응답 시에만 재로그인한다.

### ② help-desk 이슈 조회 — id 커서 방식 (GET)

```
GET https://help-desk-api.wink.co.kr/issue/issues/?model_type=1009&id__gt=<last_id>&order_by=id&limit=1000&results_only=true
x-csrftoken: <XSRF-TOKEN>
Cookie: XSRF-TOKEN=<...>; sessionid=<...>
(공통 헤더)
```

**요청 쿼리 파라미터**

| 파라미터 | 값/예시 | 설명 |
|----------|---------|------|
| model_type | 1009 | 이슈 모델 타입 (고정) |
| id__gt | `<last_id>` | 이 id보다 큰 것만 (직전까지 저장된 `issues.id`의 최댓값이 커서) |
| order_by | id | id 오름차순 — 응답의 마지막 id를 다음 커서로 사용 |
| limit | 1000 | 페이지당 최대 건수 |
| results_only | true | 페이지네이션 메타 없이 결과 배열만 응답 |

응답이 1000건 꽉 차면(공백이 길었던 경우) 이번에 받은 최댓값을 커서 삼아 이어서 요청해 누락 없이 전량을 받는다 (`helpdesk_client.fetch_issues_since()`).

**응답 필드 → 저장 컬럼**은 예전 offset 방식과 동일:

| 응답 필드 | 저장 컬럼 | 분석 사용 |
|-----------|-----------|-----------|
| id | id | ✅ 키·중복제거·증분 커서 |
| created_date | created_date | ✅ 날짜/통계 (UTC, +9h 변환) |
| complete_date | complete_date | ❌ 저장만 |
| category_tag | category_tag | ❌ 저장만 |
| data.category_tag_full_name | category_main/sub/full | △ 원본 보존(정책1), 분석엔 미사용 |
| data.call_history.call_memo | call_memo | ✅ 분류·표시 |
| student | student_id | ✅ 어드민 링크 |
| parent | parent_id | ✅ 반복 학부모·링크 |

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

승인된 호출 빈도: **하루 최대 146회**. 트리거는 항상 등록해두고, 실제 실행 여부는 매번 `get_collection_enabled()`로 확인한다 — 관리자 모드에서 서버 재시작 없이 켜고 끄면 바로 다음 트리거부터 반영된다.

| 시각 | 잡 | 비고 |
|------|-----|------|
| 09:00 | `collect_morning_catchup` | 아침보정 (밤사이 누락분 포함) — 수집 + 인사이트 캐시 갱신 |
| 09:05~20:55 (5분 간격) | `collect_regular` | 업무시간 정기 수집, 143회 |
| 21:00 | `collect_regular` | 정기 수집 마지막 1회 |
| 00:00 | `collect_night_catchup` | 심야보정 (당일 마감 정리) |

id 커서 방식이라 내부적으로는 다 같은 `collect_new()`를 부르지만, `trigger` 라벨로 `collection_log`에 정기/아침보정/심야보정/서버시작/수동을 구분해 남긴다 (관리자 페이지의 API 관리 화면에서 확인 가능).

수집과 별개로 도는 예약 작업(help-desk API 호출 없음):

| 시각 | 잡 | 내용 |
|------|-----|------|
| 매일 00:30 | `_generate_yesterday_report` | 전날 일별 보고서 자동 생성 (Gemma 분석 포함) |
| 매일 08:00 | `_cache_keyword_trend_today` | 키워드 트렌드 캐시 (탐지 이력 누락 방지) |
| 매주 월요일 00:30 | `_generate_last_week_report` | 직전 주(월~금) 주간 보고서 자동 생성 |

### 중단 스위치

`core/collection_settings.py`의 `get_collection_enabled()`/`set_collection_enabled()`가 `collection_settings.json` 파일 기반으로 CS 수집 API 호출을 전면 제어한다. 관리자 페이지(API 관리)의 토글 버튼 → `POST /api/collection/enabled`로 즉시 전환되며, **서버 재시작 없이** 바로 다음 스케줄 트리거부터 반영된다.
- 기본값은 `False`(중단) — 파일이 없어도 절대 호출하지 않는 안전장치.
- `False`: 자동 수집·Wings 조회 일절 안 함. 대시보드는 기존 DB로 정상 동작.
- `True`: 위 스케줄대로 수집 재개.

---

## 데이터 현황 & 과거 백필

현재 DB는 2026-05-15부터 누적되어 약 14주치(6만여 건) 보유 중이다. 6개월치(~10만건 이상)를 끌어오면 이탈 여정·CS 예보 등 긴 시간축 인사이트가 가능해진다. 방식은 두 가지다.

1. **`scripts/import_backfill_csv.py`**: 플랫폼엔지니어링팀이 추출해준 CSV가 있으면 이 스크립트로 바로 적재 (help-desk API 호출 없음, 가장 빠르고 안전함)
2. **`scripts/backfill_ids.py` 계열로 API 직접 스크랩**: CSV를 구하기 어려울 때만 사용. 아래 리스크·수칙을 반드시 지킨다.

### ⚠️ API 직접 스크랩 시 리스크

- `help-desk-api.wink.co.kr`는 **CS 상담원이 실시간으로 쓰는 운영 API**다. 대량 스크랩이 상담
  트래픽과 경쟁하면 운영 서버가 느려지거나 장애가 날 수 있다.
- 읽기 전용 GET이라 help-desk 데이터를 변경하진 않지만, 한 직원 계정으로 자동 트래픽을 많이
  보내면 **이상탐지·계정 잠금** 위험이 있다.

### ✅ 안전 실행 수칙

1. **오프피크 실행** — 정기 수집이 09:00~21:00 동안 동작하므로 **밤 21:00 이후 ~ 09:00 사이**에 돌린다.
2. **페이지 간 딜레이 2~5초** 삽입 (`scripts/backfill_ids.py`의 `DELAY=5` 패턴 참고).
3. **세션 1회 로그인 재사용** — 날짜마다 재로그인하지 않는다.
4. **날짜 청크 단위**로 끊어 중단·재개 가능하게 만든다.
5. 백필 후 분류 규칙이 바뀐 게 있으면 **전체 재분류**(`scripts/reclassify.py`) 실행.

### 실행 후 가능해지는 인사이트

- **이탈 여정**: 수주~수개월에 걸친 카테고리 흐름 추적. 단 "오류→해지" 인과는 짧은 기간
  데이터에서 반대로 나온 적이 있어(기술오류 고객이 해지 덜함) 데이터가 늘어난 뒤 재검증 필요.
- **CS 예보**: 8주 이상 이력 기반 기대 범위·이상 감지.
- ※ "해지 상담"은 실제 해지가 아닌 *상담 접수*임에 유의.

---

## 미구현 항목

- **Teams 알림**: 임계값 기반 이상 감지 알림
- **공식 도메인·HTTPS**: 사내 인프라팀의 "현업주도개발" 지원 절차를 통해 공식 배포 서버·도메인·인증 방안을 받을 예정. 그전까지는 내부망 Docker 배포로 운영
- **CS 예보**: CS 급증 이상감지. "배포가 원인"까지 엮으려면 배포 일자 데이터 필요 → **보류** (배포 일자 확보 후 진행)
- **Watchtower 등 자동 배포**: 공식 인프라팀의 배포·변경 관리 방식이 정해지면 그에 맞춰 결정
