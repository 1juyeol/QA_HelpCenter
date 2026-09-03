// 관리자 전용 "CS 수집 API" 콘솔. 세 가지를 보여준다:
//   1) 승인된 API 호출 규칙 — 회사에 승인받은 호출 스펙을 코드 주석이 아닌 화면에 고정 기록
//   2) CS 수집 호출 횟수 모니터링 — 최근 CALL_COUNT_DAYS일간 날짜별 실제 호출 횟수
//      (GET /api/collection/daily_counts). 하루 최대 DAILY_CALL_LIMIT회를 넘긴 날은 그 자리에서
//      펼쳐서 개별 호출 내역까지 볼 수 있다(GET /api/collection/log/over-limit, 날짜별로 접힘/
//      5개씩 페이지네이션) — 예전엔 "한도 초과일 호출 이력"이 별도 섹션으로 날짜를 다시
//      나열했는데, 같은 날짜가 두 곳에 쪼개져 보이는 게 불필요해서 이 표 안으로 합쳤다.
//   3) 오늘 호출별 상세 로그 — 호출 하나하나 클릭하면 실제로 가져온 이슈 목록까지 확인 가능
//      (GET /api/collection/log, GET /api/collection/log/{id}/issues)
// 1)은 이 파일 안의 정적 목록, 나머지는 API를 호출한다.
// 원래 "해야 할 일" 페이지에 다 몰려있던 걸, 내용이 많아져서 이 페이지로 분리했다.
// 감사 로그 페이지와 텍스트 크기·뱃지 스타일(components/Badge.tsx 공용)을 맞춰 통일감을 줬다.
//
// 스케줄을 벗어난 호출(source가 정기/아침보정/심야보정이 아닌 경우 — 예: 서버 재시작 시
// 한 번 도는 "서버시작")은 SCHEDULED_SOURCES에 없으면 빨간 배지로 강조해서, 예정에 없던
// 호출이 섞여 있는지 한눈에 알아볼 수 있게 한다.
//
// 접근 제어: useAdmin()의 isAdmin이 false면 본문 대신 잠금 안내만 보여준다.
// 2)·3)이 보여주는 call_memo·student_id 등은 이미 /api/issues로 앱 전체에서 인증 없이
// 노출되는 데이터라(내부 CS 도구 전제) 이 엔드포인트도 별도 보호를 두지 않았다.
import { useEffect, useState, type ReactNode } from 'react'
import { api, type CollectionDailyCount, type CollectionLogEntry, type Issue } from '../../api/client'
import { useAdmin } from '../../hooks/useAdmin'
import Badge from '../../components/Badge'
import PaginatedList from '../../components/PaginatedList'

const DAILY_CALL_LIMIT = 146
// 스케줄러가 실제로 등록하는 트리거 라벨(features/collection/scheduler.py 참고). 이 셋 외에는
// 고정된 시각 없이 발생하는 호출(서버 재시작 등)이라 "스케줄을 벗어난 호출"로 표시한다.
const SCHEDULED_SOURCES = new Set(['정기', '아침보정', '심야보정'])

// 실제 구현(features/collection/scheduler.py, helpdesk_client.py)과 반드시 같이 업데이트할 것.
// 여기 적힌 스펙이 승인받은 최종본이며, 코드가 이걸 정확히 따르는지는 아래 모니터링 표로 확인한다.
const API_RULE = {
  approvedDate: '2026-08',
  endpoint: 'https://help-desk-api.wink.co.kr/issue/issues/',
  params: 'model_type=1009, id__gt={마지막 저장 id}, order_by=id, limit=1000, results_only=true',
  method: 'id 커서 방식 — 시간 창이 아니라 "마지막으로 저장한 id보다 큰 것만" 조회. 마지막 id는 우리 DB(issues 테이블 MAX(id))에서 매번 구함',
  schedule: [
    '09:00 — 아침보정 (자정~09:00 사이 등록분) + 인사이트 캐시 갱신',
    '09:05~20:55 — 5분 간격 정기 수집',
    '21:00 — 정기 수집 마지막 1회',
    '00:00 — 심야보정 (전일 21:00~00:00 사이 등록분)',
  ],
  dailyLimit: 146,
  fields: ['id', 'created_date', 'complete_date', 'category_tag_full_name', 'call_memo', 'student', 'parent'],
}

function SpecRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '150px 1fr', gap: 16,
      padding: '12px 0', borderBottom: '1px solid #f1f5f9',
    }}>
      <div style={{ color: '#94a3b8', fontWeight: 700, fontSize: 13 }}>{label}</div>
      <div style={{ color: '#1e293b', fontSize: 14, lineHeight: 1.5 }}>{children}</div>
    </div>
  )
}

function ApiRuleReference() {
  return (
    <div className="section-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>승인된 API 호출 규칙</h2>
        <Badge color="#16a34a">{API_RULE.approvedDate} 승인</Badge>
      </div>
      <div style={{ marginTop: 8 }}>
        <SpecRow label="대상 API">
          <code style={{ background: '#f1f5f9', padding: '3px 8px', borderRadius: 4, fontSize: 13 }}>
            {API_RULE.endpoint}
          </code>
        </SpecRow>
        <SpecRow label="파라미터">
          <code style={{ background: '#f1f5f9', padding: '3px 8px', borderRadius: 4, fontSize: 13, wordBreak: 'break-all', display: 'inline-block' }}>
            {API_RULE.params}
          </code>
        </SpecRow>
        <SpecRow label="조회 방식">{API_RULE.method}</SpecRow>
        <SpecRow label={`호출 스케줄 (하루 최대 ${API_RULE.dailyLimit}회)`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {API_RULE.schedule.map(s => <div key={s}>· {s}</div>)}
          </div>
        </SpecRow>
        <SpecRow label="수집 항목">{API_RULE.fields.join(', ')}</SpecRow>
      </div>
    </div>
  )
}

const CALL_COUNT_DAYS = 30

function CollectionCallCounts() {
  const [counts, setCounts] = useState<CollectionDailyCount[] | null>(null)
  const [overLimitEntries, setOverLimitEntries] = useState<CollectionLogEntry[] | null>(null)

  useEffect(() => {
    api.fetchCollectionDailyCounts(CALL_COUNT_DAYS).then(setCounts).catch(() => setCounts([]))
    api.fetchCollectionLogOverLimit().then(setOverLimitEntries).catch(() => setOverLimitEntries([]))
  }, [])

  // 한도를 넘긴 날짜(day) → 그날의 개별 호출 목록. 위 30일 목록에서 한도 초과 표시가 뜬
  // 날을 클릭하면 이 목록을 그대로 펼쳐서 보여준다(OverLimitDateGroup 재사용) — 날짜를
  // 두 번 나열하지 않고 한 표 안에서 접었다 펼 수 있게 하기 위함.
  const overLimitByDay = new Map((overLimitEntries ? groupByDay(overLimitEntries) : []).map(g => [g.day, g.entries]))

  return (
    <div className="section-card">
      <h2 style={{ fontSize: 16 }}>CS 수집 호출 횟수 (최근 {CALL_COUNT_DAYS}일)</h2>
      <p style={{ color: '#64748b', fontSize: 14, marginTop: -6, marginBottom: 14 }}>
        API 호출 시에만 기록되는 데이터로, 일일 한도({DAILY_CALL_LIMIT}회) 준수 여부를
        확인합니다. 초과일은 개별 내역 확인이 가능합니다.
      </p>
      {counts === null ? (
        <div style={{ fontSize: 14, color: '#94a3b8' }}>불러오는 중...</div>
      ) : counts.length === 0 ? (
        <div style={{ fontSize: 14, color: '#94a3b8' }}>기록 없음 (수집이 아직 한 번도 실행되지 않음)</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {counts.map(c => {
            const over = c.count > DAILY_CALL_LIMIT
            const entries = overLimitByDay.get(c.day)
            if (over && entries) {
              return <OverLimitDateGroup key={c.day} day={c.day} entries={entries} />
            }
            return (
              <div
                key={c.day}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 14px', background: '#f8fafc', borderRadius: 8,
                }}
              >
                <span style={{ fontSize: 15, color: '#1e293b' }}>{c.day}</span>
                {over ? (
                  <Badge color="#ef4444">{c.count}회 · 한도 {DAILY_CALL_LIMIT}회 초과</Badge>
                ) : (
                  <Badge color="#16a34a">{c.count}회</Badge>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function LogRow({ entry }: { entry: CollectionLogEntry }) {
  const [open, setOpen] = useState(false)
  const [issues, setIssues] = useState<Issue[] | null>(null)

  async function toggle() {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (issues === null) {
      const result = await api.fetchCollectionLogIssues(entry.id).catch(() => ({ items: [] }))
      setIssues(result.items)
    }
  }

  return (
    <div style={{ background: '#f8fafc', borderRadius: 8, overflow: 'hidden' }}>
      <button
        onClick={toggle}
        disabled={entry.count_fetched === 0}
        style={{
          width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '10px 14px', background: 'transparent', border: 'none',
          cursor: entry.count_fetched === 0 ? 'default' : 'pointer', textAlign: 'left',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15, color: '#1e293b' }}>{entry.collected_at}</span>
            {entry.source && (
              <Badge color={SCHEDULED_SOURCES.has(entry.source) ? undefined : '#ef4444'}>
                {entry.source}{!SCHEDULED_SOURCES.has(entry.source) && ' · 스케줄 외'}
              </Badge>
            )}
          </div>
          {entry.count_fetched > 0 && (
            <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 4 }}>
              id {entry.last_id} → {entry.end_id}
            </div>
          )}
        </div>
        <span style={{ fontSize: 14, color: entry.status === 'error' ? '#ef4444' : '#64748b' }}>
          {entry.status === 'error' ? `실패: ${entry.message}` : `${entry.count_fetched}건`}
          {entry.count_fetched > 0 && (open ? ' ▲' : ' ▼')}
        </span>
      </button>
      {open && (
        <div style={{ padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {issues === null ? (
            <div style={{ fontSize: 13, color: '#94a3b8' }}>불러오는 중...</div>
          ) : issues.length === 0 ? (
            <div style={{ fontSize: 13, color: '#94a3b8' }}>목록 없음</div>
          ) : (
            issues.map(iss => (
              <div key={iss.id} style={{ fontSize: 13, color: '#475569', background: '#fff', borderRadius: 6, padding: '8px 10px' }}>
                #{iss.id} · {iss.created_date} · {iss.new_category_main ?? '미분류'}
                {iss.new_category_sub ? ` / ${iss.new_category_sub}` : ''}
                <div style={{ color: '#94a3b8', marginTop: 3, fontSize: 13 }}>{iss.call_memo?.slice(0, 60) || '(메모 없음)'}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// 같은 날짜의 로그끼리 묶는다. entries는 항상 id 내림차순(최신 먼저)으로 오고, id는
// 시간순으로 늘어나므로 같은 날짜의 행은 항상 연속으로 붙어 있다 — 그룹 경계만 찾으면 된다.
export function groupByDay(entries: CollectionLogEntry[]): Array<{ day: string; entries: CollectionLogEntry[] }> {
  const groups: Array<{ day: string; entries: CollectionLogEntry[] }> = []
  for (const e of entries) {
    const day = e.collected_at.slice(0, 10)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.entries.push(e)
    else groups.push({ day, entries: [e] })
  }
  return groups
}

function OverLimitDateGroup({ day, entries }: { day: string; entries: CollectionLogEntry[] }) {
  const [open, setOpen] = useState(false)

  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 14px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 15, color: '#1e293b', fontWeight: 700 }}>{day}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Badge color="#ef4444">{entries.length}회 · 한도 {DAILY_CALL_LIMIT}회 초과</Badge>
          <span style={{ fontSize: 14, color: '#94a3b8' }}>{open ? '▲' : '▼'}</span>
        </span>
      </button>
      {open && (
        <div style={{ padding: '0 14px 14px' }}>
          <PaginatedList items={entries} pageSize={5} getKey={e => e.id} renderItem={e => <LogRow entry={e} />} />
        </div>
      )}
    </div>
  )
}

function CollectionLogList() {
  const [entries, setEntries] = useState<CollectionLogEntry[] | null>(null)

  useEffect(() => {
    api.fetchCollectionLog().then(setEntries).catch(() => setEntries([]))
  }, [])

  return (
    <div className="section-card">
      <h2 style={{ fontSize: 16 }}>오늘 호출별 상세 로그</h2>
      <p style={{ color: '#64748b', fontSize: 14, marginTop: -6, marginBottom: 14 }}>
        호출별로 실제 조회된 이슈 목록을 정확하게 확인할 수 있습니다.
      </p>
      {entries === null ? (
        <div style={{ fontSize: 14, color: '#94a3b8' }}>불러오는 중...</div>
      ) : entries.length === 0 ? (
        <div style={{ fontSize: 14, color: '#94a3b8' }}>오늘 호출 기록 없음</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {entries.map(e => <LogRow key={e.id} entry={e} />)}
        </div>
      )}
    </div>
  )
}

export default function ApiConsole() {
  const { isAdmin } = useAdmin()

  if (!isAdmin) {
    return (
      <div className="section-card">
        <h2>🔒 관리자 전용 페이지</h2>
        <p style={{ color: '#64748b', fontSize: 14 }}>
          사이드바 하단의 잠금 아이콘에서 관리자 암호를 입력해야 볼 수 있습니다.
        </p>
      </div>
    )
  }

  return (
    <div>
      <ApiRuleReference />
      <CollectionCallCounts />
      <CollectionLogList />
    </div>
  )
}
