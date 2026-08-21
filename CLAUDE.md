# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

Tradeoff: These guidelines bias toward caution over speed. For trivial tasks, use judgment.

1. Think Before Coding
Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

State your assumptions explicitly. If uncertain, ask.
If multiple interpretations exist, present them - don't pick silently.
If a simpler approach exists, say so. Push back when warranted.
If something is unclear, stop. Name what's confusing. Ask.
2. Simplicity First
Minimum code that solves the problem. Nothing speculative.

No features beyond what was asked.
No abstractions for single-use code.
No "flexibility" or "configurability" that wasn't requested.
No error handling for impossible scenarios.
If you write 200 lines and it could be 50, rewrite it.
Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

3. Surgical Changes
Touch only what you must. Clean up only your own mess.

When editing existing code:

Don't "improve" adjacent code, comments, or formatting.
Don't refactor things that aren't broken.
Match existing style, even if you'd do it differently.
If you notice unrelated dead code, mention it - don't delete it.
When your changes create orphans:

Remove imports/variables/functions that YOUR changes made unused.
Don't remove pre-existing dead code unless asked.
The test: Every changed line should trace directly to the user's request.

4. Goal-Driven Execution
Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

"Add validation" → "Write tests for invalid inputs, then make them pass"
"Fix the bug" → "Write a test that reproduces it, then make it pass"
"Refactor X" → "Ensure tests pass before and after"
For multi-step tasks, state a brief plan:

1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

# CS 대시보드 프로젝트 정책

## [정책 1] 원본 분류 수정 금지

`category_main/sub`는 help-desk 시스템에서 내려오는 원본값이다. 읽기 전용으로 유지하고, 분석·표시에는 `new_category_main/sub`만 사용한다.

**왜 필요한가:** 원본값을 덮어쓰면 help-desk와 대시보드 간 데이터 정합성이 깨진다. 재분류 로직이 바뀌어도 원본이 보존되어 있어야 비교·롤백이 가능하다.

## [정책 2] SQL 날짜 필터는 반드시 KST 변환

날짜 필터링 시 `datetime(created_date, '+9 hours')`를 반드시 포함한다. `created_date`는 UTC로 저장된다.

**왜 필요한가:** 변환 없이 날짜 필터를 적용하면 자정~09시 데이터가 실제와 하루 차이가 난다. 매 집계마다 필요하며 빠트리기 쉬운 지점이다.

## [정책 3] DB 접근은 get_conn()만

SQLite 연결은 `db.py`의 `get_conn()`을 통해서만 열고 닫는다. 각 파일에서 직접 `sqlite3.connect()`를 호출하지 않는다.

**왜 필요한가:** DB 경로, row_factory 설정 등 연결 옵션이 `get_conn()` 한 곳에 집중되어 있다. 분산되면 설정 변경 시 여러 파일을 수정해야 한다.

## [정책 4] 분류 규칙 변경 시 전체 재적용 필수

`classifier.py`의 `RULES`나 `FALLBACK_SUBS`를 수정한 후에는 전체 `issues` 테이블에 재분류를 실행해야 한다.

**왜 필요한가:** 새 규칙은 이후 수집 건에만 적용되고 과거 데이터는 이전 규칙 그대로 남는다. 재적용 없이 배포하면 동일 기간이라도 분류 기준이 달라진 상태가 된다.

## [정책 5] 시간 비교는 마지막 완료 버킷 기준

현재 진행 중인 30분 버킷을 비교 대상에 포함하지 않는다. `getCurrentBucket()`이 30분 후행하는 이유다.

**왜 필요한가:** 14:37에 현재 버킷(14:30~)을 포함하면 7분치 데이터를 어제의 30분 전체와 비교하게 된다. 완료된 버킷끼리만 비교해야 공정한 수치가 된다.

## [정책 6] 일별 평균은 평일만

일별 비교 평균 계산 시 토/일요일 데이터를 제외한다.

**왜 필요한가:** 주말은 상담 건수가 거의 0에 가깝다. 포함하면 주평균이 실제 업무일 대비 과소 산출되어 비교 지표가 왜곡된다.

## [정책 7] App.tsx는 순수 라우터 *(React 마이그레이션 후)*

`App.tsx`는 레이아웃 렌더링과 라우팅만 담당한다. 기능 로직, API 호출, 상태 관리를 직접 포함하지 않는다.

**왜 필요한가:** App.tsx에 로직이 쌓이면 페이지가 늘어날수록 관리가 불가능해진다. QA_Tools의 sidebar.js가 순수 라우터를 유지하는 것과 같은 원칙이다.

## [정책 8] 각 페이지는 독립적 *(React 마이그레이션 후)*

`pages/` 하위 각 파일은 다른 페이지 파일을 직접 참조하지 않는다. 공유 로직은 `components/` 또는 `api/`로만 접근한다.

**왜 필요한가:** 페이지 간 직접 의존이 생기면 한 페이지 수정이 다른 페이지에 영향을 준다. 독립성이 보장되어야 페이지 단위 추가·수정·삭제가 안전하다.

## [정책 9] API 호출은 api/client.ts에서만 *(React 마이그레이션 후)*

컴포넌트 내부에서 `fetch`를 직접 호출하지 않는다. 모든 API 호출은 `api/client.ts`를 통한다.

**왜 필요한가:** 엔드포인트 경로나 인증 방식이 바뀔 때 한 파일만 수정하면 된다. 컴포넌트마다 분산되면 변경 시 누락이 생긴다.

## [정책 10] 기능 제거 시 연관 코드 전부 삭제

페이지·기능을 제거하거나 다른 방식으로 대체할 때, 연관된 코드를 모두 함께 삭제한다.

- 백엔드 엔드포인트 삭제 → `client.ts`의 메서드·타입 인터페이스도 삭제
- 프론트 메서드·타입 삭제 → 백엔드 엔드포인트도 삭제
- 엔드포인트 전용 상수·헬퍼 함수도 함께 삭제

**왜 필요한가:** 한쪽만 지우면 타입 오류나 dead endpoint가 남는다. 감사 때마다 같은 문제가 반복된다.

## [정책 11] 순수 함수 신규 추가 시 테스트 필수

DB·외부 API 의존 없이 입력→출력이 결정되는 순수 함수를 새로 작성하면, 같은 PR에서 테스트를 함께 작성한다.

- 백엔드(Python): `backend/tests/test_*.py`
- 프론트엔드(TypeScript): 대상 파일 옆 `*.test.ts`

**왜 필요한가:** 구현 시점에 테스트를 생략하면 사후 감사에서만 발견된다. 순수 함수는 mock 없이 바로 테스트 가능하므로 이유가 없다.

---

## 실행 명령

**백엔드**
```bash
cd backend
uvicorn server:app --host 0.0.0.0 --port 8000
```

**프론트엔드** *(React 마이그레이션 후)*
```bash
cd frontend
npm run dev      # 개발 서버
npm run build    # 프로덕션 빌드
```

**Docker** (backend+frontend 컨테이너 통합 실행, 내부망 배포용)
```bash
docker compose up --build -d
```
기본 포트 8092(frontend가 서빙, `/api`는 nginx가 backend로 프록시). `backend/.env`를 컨테이너에 그대로 주입하며 이미지에는 포함되지 않는다. 상세: 루트 `README.md`의 "설치 및 실행 > Docker" 참고.

---

## 저장소 관례

**브랜치**: `ljy` 하나를 계속 재사용한다. 작업분을 커밋해 `ljy → main` PR을 올리고, 머지되면 이어서 같은 브랜치에 다음 작업을 쌓는다. 새 브랜치는 명시적으로 요청받았을 때만 만든다.
**커밋**: 개인 전역 CLAUDE.md 규칙을 따른다 — `타입: 함수명1, 함수명2 - 한줄 요약` 형식, 본문은 함수명·식별자 없이 평문으로.
예: `fix: classify, extract_symptom_fields - CS 메모 오분류 키워드 수정 및 전체 재분류`
