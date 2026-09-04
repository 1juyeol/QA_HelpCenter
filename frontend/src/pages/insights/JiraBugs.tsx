// 미해결 Jira 이슈 모니터링 페이지. DQ-424 에픽 하위 이슈 중 [학생앱]·[학부모앱]·[PC홈페이지]
// 태그가 있고 종료·완료 아닌 이슈를 전부 모아 보여준다. 공감센터가 상담 메모에 이 이슈들을
// 인용하는 일이 없어 상담 건수·메모 매칭 기능은 두지 않는다 — 순수하게 "이 이슈가 오래
// 해결되지 않고 있으니 개발팀 조치가 필요하다"를 알리는 목적이다. 제목·카드 라벨에 "방치"
// 대신 "미해결"/"경과"를 쓴다 — 주간보고서에 이 페이지 스냅샷을 넣게 될 경우를 대비해
// 부정적으로 읽힐 수 있는 단어를 피한 것.
// 마운트 시 GET /api/jira/bugs(이슈 목록)·GET /api/jira/trend(전체/검토 대기/6개월+/1년+
// 미해결 건수 일별 스냅샷)·GET /api/jira/resolved(최근 7일 내 해결된 이슈)를 같이 fetch하고,
// 새로고침 버튼(관리자 전용)은 POST /api/jira/sync → 재조회 순서로 동작한다.
// KPI 카드 4개 — 전체 이슈(클릭하면 필터 해제) / 검토 대기 이슈(상태='미해결') / 6개월 이상
// / 1년 이상. 뒤 두 개는 6개월+ ⊇ 1년+ 중첩 구간이라 겹칠 수 있고, 클릭하면 아래 표가 그
// 조건으로 필터링된다.
// 미해결 건수 추이(6개월+/1년+ 스냅샷을 주 단위로 묶은 선 그래프) → 최근 1주일 내 해결된
// 이슈 목록(5건씩 페이지네이션, 컬럼: 이슈/요약/생성일/해결일) → 상세 테이블(이슈·요약·
// 상태·생성일·경과일, 컬럼 헤더 클릭으로 정렬) 순으로 구성된다. 기본 정렬은 경과일 내림차순.
// WingsTickets.tsx와 같은 구조로 카드 선택과 무관하게 상태 드롭다운(전체+JIRA 실제 상태값)을
// 항상 보여주고(카드 필터와 AND로 결합), 표는 페이지네이션(기본 50개씩)으로 자른다.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Chart from 'chart.js/auto'
import { api, type JiraBug, type JiraBugSnapshot, type JiraResolvedBug } from '../../api/client'
import { useAdmin } from '../../hooks/useAdmin'

const NAVY = '#1e3c72'
const AMBER = '#f59e0b'
const RISK_RED = '#ef4444'

// JIRA에 실제로 존재하는 상태명을 그대로 쓴다(별도 번역·축약 없음) — "검토중"(공백 없음)과
// "검토 중"(공백 있음)이 JIRA 쪽에 둘 다 존재해 별개 키로 등록해뒀다.
const STATUS_COLOR: Record<string, { bg: string; color: string }> = {
  '미해결':       { bg: '#fee2e2', color: '#ef4444' },
  '검토 중':      { bg: '#fef9c3', color: '#b45309' },
  '검토중':       { bg: '#fef9c3', color: '#b45309' },
  '진행 중':      { bg: '#eff6ff', color: '#1a56db' },
  'Staging Done': { bg: '#f3e8ff', color: '#7c3aed' },
  'QA확인':       { bg: '#dcfce7', color: '#15803d' },
  'PENDING':      { bg: '#f1f5f9', color: '#64748b' },
  'Backlog':      { bg: '#f1f5f9', color: '#64748b' },
}

const PENDING_REVIEW_STATUS = '미해결'
const SIX_MONTH_DAYS = 180
const ONE_YEAR_DAYS = 365

export function getAgeDays(bug: JiraBug): number {
  return Math.floor((Date.now() - new Date(bug.created_at).getTime()) / 86400000)
}

export function isPendingReview(bug: JiraBug): boolean {
  return bug.status === PENDING_REVIEW_STATUS
}

export function isSixMonthOrMore(bug: JiraBug): boolean {
  return getAgeDays(bug) >= SIX_MONTH_DAYS
}

export function isOneYearOrMore(bug: JiraBug): boolean {
  return getAgeDays(bug) >= ONE_YEAR_DAYS
}

type CardFilter = 'all' | 'pendingReview' | 'sixMonth' | 'oneYear'
const CARD_FILTER_VALUES: CardFilter[] = ['all', 'pendingReview', 'sixMonth', 'oneYear']

const CARD_PREDICATE: Record<Exclude<CardFilter, 'all'>, (b: JiraBug) => boolean> = {
  pendingReview: isPendingReview,
  sixMonth: isSixMonthOrMore,
  oneYear: isOneYearOrMore,
}

type SortKey = 'key' | 'status' | 'created_at' | 'ageDays'

function getSortValue(b: JiraBug, key: SortKey): number | string {
  switch (key) {
    case 'key': return b.key
    case 'status': return b.status
    case 'created_at': return b.created_at
    case 'ageDays': return getAgeDays(b)
  }
}

// 표시할 "동기화" 시각 — 이슈 목록의 첫 번째 행이 아니라 전체 중 가장 최근 synced_at을 쓴다.
// (동기화할 때마다 모든 이슈의 synced_at이 같은 값으로 갱신되므로 원래는 아무 값이나 같아야
// 하지만, 예전엔 이번 조회에서 빠진 이슈를 캐시에서 지우지 않아 그 이슈의 synced_at만 과거에
// 멈춰 있었다 — 정렬 순서에 따라 그 오래된 값이 화면에 뜨면서 "동기화가 멈췄다"로 보였다.)
export function getLatestSyncedAt(bugs: JiraBug[]): string | null {
  let latest: string | null = null
  for (const b of bugs) {
    if (b.synced_at && (!latest || b.synced_at > latest)) latest = b.synced_at
  }
  return latest
}

export function compareRows(a: JiraBug, b: JiraBug, key: SortKey, dir: 'asc' | 'desc'): number {
  const av = getSortValue(a, key)
  const bv = getSortValue(b, key)
  const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'ko')
  return dir === 'desc' ? -cmp : cmp
}

function SortableTh({
  label, sortKey: key, width, currentKey, currentDir, onSort,
}: {
  label: string; sortKey: SortKey; width?: number
  currentKey: SortKey; currentDir: 'asc' | 'desc'; onSort: (key: SortKey) => void
}) {
  const active = currentKey === key
  return (
    <th style={{ width, cursor: 'pointer', userSelect: 'none', fontSize: 16 }} onClick={() => onSort(key)}>
      {label}
      <span style={{ marginLeft: 3, color: active ? '#1a56db' : '#cbd5e1', fontWeight: active ? 700 : 400 }}>
        {active ? (currentDir === 'desc' ? '▼' : '▲') : '▼'}
      </span>
    </th>
  )
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_COLOR[status] ?? { bg: '#f1f5f9', color: '#64748b' }
  return <span style={{ display: 'inline-block', background: s.bg, color: s.color, borderRadius: 999, padding: '2px 8px', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>{status}</span>
}

// snapshot_date(YYYY-MM-DD)가 속한 주의 월요일 — WingsTickets.tsx의 weekStartOf와 같은 방식.
function weekStartOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  const day = d.getDay()
  const diffToMonday = day === 0 ? 6 : day - 1
  d.setDate(d.getDate() - diffToMonday)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function groupSnapshotsByWeek(snapshots: JiraBugSnapshot[]): { week: string; sixMonth: number; oneYear: number }[] {
  const byWeek = new Map<string, JiraBugSnapshot>()
  for (const s of snapshots) {
    byWeek.set(weekStartOf(s.snapshot_date), s)
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, s]) => ({ week, sixMonth: s.six_month_count, oneYear: s.one_year_count }))
}

export default function JiraBugs() {
  const { isAdmin, adminToken } = useAdmin()
  const [searchParams] = useSearchParams()
  const [bugs, setBugs] = useState<JiraBug[]>([])
  const [trend, setTrend] = useState<JiraBugSnapshot[]>([])
  const [resolvedBugs, setResolvedBugs] = useState<JiraResolvedBug[]>([])
  const [resolvedPage, setResolvedPage] = useState(1)
  const [resolvedPageSize, setResolvedPageSize] = useState(5)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('ageDays')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const [cardFilter, setCardFilter] = useState<CardFilter>(() => {
    const f = searchParams.get('filter')
    return (CARD_FILTER_VALUES as string[]).includes(f ?? '') ? (f as CardFilter) : 'all'
  })
  // 카드와 무관하게 항상 노출되는 상태 필터. 카드 필터와 별개(AND)로 적용된다 —
  // WingsTickets.tsx의 상태 필터와 같은 방식.
  const [statusFilter, setStatusFilter] = useState<string>('all')
  // 티켓 캡을 없앤 WingsTickets.tsx와 같은 이유로 페이지네이션을 둔다 — 기본값도 동일하게 50.
  const [pageSize, setPageSize] = useState(50)
  const [page, setPage] = useState(1)

  const statusOptions = useMemo(
    () => [...new Set(bugs.map(b => b.status))].sort((a, b) => a.localeCompare(b, 'ko')),
    [bugs],
  )

  const cardFilteredBugs = useMemo(
    () => cardFilter === 'all' ? bugs : bugs.filter(CARD_PREDICATE[cardFilter]),
    [bugs, cardFilter],
  )
  const filteredBugs = useMemo(
    () => statusFilter === 'all' ? cardFilteredBugs : cardFilteredBugs.filter(b => b.status === statusFilter),
    [cardFilteredBugs, statusFilter],
  )
  const sortedBugs = useMemo(
    () => [...filteredBugs].sort((a, b) => compareRows(a, b, sortKey, sortDir)),
    [filteredBugs, sortKey, sortDir],
  )

  useEffect(() => { setPage(1) }, [cardFilter, statusFilter, pageSize])
  useEffect(() => { setResolvedPage(1) }, [resolvedBugs, resolvedPageSize])

  const totalPages = Math.max(1, Math.ceil(sortedBugs.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pagedBugs = sortedBugs.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  const resolvedTotalPages = Math.max(1, Math.ceil(resolvedBugs.length / resolvedPageSize))
  const resolvedCurrentPage = Math.min(resolvedPage, resolvedTotalPages)
  const pagedResolvedBugs = resolvedBugs.slice(
    (resolvedCurrentPage - 1) * resolvedPageSize, resolvedCurrentPage * resolvedPageSize,
  )

  function handleCardClick(filter: CardFilter) {
    setCardFilter(prev => prev === filter ? 'all' : filter)
  }

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const trendCanvasRef = useRef<HTMLCanvasElement>(null)
  const trendChartRef = useRef<Chart | null>(null)
  const chartSectionRef = useRef<HTMLDivElement>(null)
  const cameFromCardLink = useRef(searchParams.get('filter') !== null)

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (!loading && bugs.length > 0 && cameFromCardLink.current) {
      cameFromCardLink.current = false
      requestAnimationFrame(() => chartSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }, [loading, bugs])

  const weeklyTrend = useMemo(() => groupSnapshotsByWeek(trend).slice(-12), [trend])

  useEffect(() => {
    if (loading || weeklyTrend.length < 2 || !trendCanvasRef.current) return

    trendChartRef.current?.destroy()
    trendChartRef.current = new Chart(trendCanvasRef.current, {
      type: 'line',
      data: {
        labels: weeklyTrend.map(w => w.week.slice(5).replace('-', '/')),
        datasets: [
          {
            label: '6개월 이상', data: weeklyTrend.map(w => w.sixMonth),
            borderColor: AMBER, backgroundColor: AMBER, tension: 0.2,
          },
          {
            label: '1년 이상', data: weeklyTrend.map(w => w.oneYear),
            borderColor: RISK_RED, backgroundColor: RISK_RED, tension: 0.2,
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 17 }, boxWidth: 12 } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${Number(ctx.parsed.y).toLocaleString()}건` } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#374151', font: { size: 13 } } },
          y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { color: '#374151', font: { size: 13 }, stepSize: 1 } },
        },
      },
    })
  }, [loading, weeklyTrend])

  useEffect(() => () => { trendChartRef.current?.destroy() }, [])

  async function load() {
    setLoading(true)
    try {
      const [res, trendRes, resolvedRes] = await Promise.all([
        api.fetchJiraBugs(), api.fetchJiraTrend(), api.fetchJiraResolved(),
      ])
      setBugs(res.data || [])
      setTrend(trendRes.data || [])
      setResolvedBugs(resolvedRes.data || [])
      const ts = getLatestSyncedAt(res.data || [])
      setSyncedAt(ts ? ts.slice(0, 16) : null)
    } finally {
      setLoading(false)
    }
  }

  async function handleSync() {
    if (!adminToken) return
    setSyncing(true)
    try {
      await api.syncJiraBugs(adminToken)
      await load()
    } finally {
      setSyncing(false)
    }
  }

  const jiraUrl = (key: string) => `https://danbiedu-dev.atlassian.net/browse/${key}`

  const pendingReviewCount = bugs.filter(isPendingReview).length
  const sixMonthCount = bugs.filter(isSixMonthOrMore).length
  const oneYearCount = bugs.filter(isOneYearOrMore).length

  const cards: Array<{ key: CardFilter; label: string; value: number }> = [
    { key: 'all', label: '전체 이슈', value: bugs.length },
    { key: 'pendingReview', label: '검토 대기 이슈', value: pendingReviewCount },
    { key: 'sixMonth', label: '6개월 이상', value: sixMonthCount },
    { key: 'oneYear', label: '1년 이상', value: oneYearCount },
  ]

  return (
    <div className="container">
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, marginBottom: 4, fontSize: 24, fontWeight: 700, color: '#1e293b' }}>미해결 Jira 이슈</h2>
        <p style={{ margin: 0, fontSize: 18, color: '#94a3b8' }}>
          고객 서비스에 영향을 줄 수 있는 미해결 이슈 현황입니다. 카드를 선택하면 해당 조건의 이슈만 확인할 수 있습니다.
        </p>
      </div>

      {!loading && bugs.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 8 }}>
            {cards.map(card => {
              const active = cardFilter === card.key
              return (
                <button
                  key={card.key}
                  onClick={() => handleCardClick(card.key)}
                  style={{
                    textAlign: 'left', cursor: 'pointer', border: 'none', background: '#fff',
                    borderRadius: 12, padding: '20px 22px',
                    boxShadow: active
                      ? `0 0 0 2px ${NAVY}, 0 4px 14px ${NAVY}40`
                      : '0 1px 4px rgba(0,0,0,.07)',
                    borderLeft: `4px solid ${NAVY}`,
                  }}
                >
                  <div style={{
                    fontSize: 30, fontWeight: 700, color: '#64748b',
                    textTransform: 'uppercase', letterSpacing: '.6px', marginBottom: 8,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }} title={card.label}>
                    {card.label}
                  </div>
                  <div style={{ fontSize: 45, fontWeight: 800, color: '#0f172a', lineHeight: 1 }}>{card.value.toLocaleString()}건</div>
                </button>
              )
            })}
          </div>
          <div style={{ fontSize: 15, color: '#94a3b8', marginBottom: 16 }}>
            6개월 이상·1년 이상은 중첩되는 구간이며, 하나의 이슈가 두 카드에 동시에 반영될 수 있습니다.
          </div>

          <div ref={chartSectionRef} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#1e293b', marginBottom: 12 }}>미해결 건수 추이</div>
            {weeklyTrend.length < 2 ? (
              <div className="empty" style={{ fontSize: 20 }}>
                데이터 축적을 시작한 시점부터 집계되며, 추이 확인까지 수 주가 소요됩니다.
              </div>
            ) : (
              <div style={{ height: 240 }}>
                <canvas ref={trendCanvasRef} />
              </div>
            )}
          </div>

          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, marginTop: 16 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#1e293b', marginBottom: 12 }}>최근 1주일 내 해결된 이슈</div>
            {!resolvedBugs.length ? (
              <div className="empty" style={{ fontSize: 20 }}>최근 1주일 내 해결된 이슈가 없습니다.</div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, color: '#64748b' }}>페이지당</span>
                    <select
                      value={resolvedPageSize}
                      onChange={e => setResolvedPageSize(Number(e.target.value))}
                      style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, color: '#374151', background: '#fff' }}
                    >
                      {[5, 10, 20, 50, 100].map(n => <option key={n} value={n}>{n}개씩</option>)}
                    </select>
                  </div>
                  <span style={{ fontSize: 20, fontWeight: 700, color: NAVY }}>총 {resolvedBugs.length.toLocaleString()}건</span>
                </div>
                <div className="insight-table-wrap">
                  <table style={{ tableLayout: 'fixed' }}>
                    <thead>
                      <tr>
                        <th style={{ width: 100, fontSize: 16 }}>이슈</th>
                        <th style={{ fontSize: 16 }}>요약</th>
                        <th style={{ width: 100, fontSize: 16 }}>생성일</th>
                        <th style={{ width: 100, fontSize: 16 }}>해결일</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedResolvedBugs.map(bug => (
                        <tr key={bug.key}>
                          <td>
                            <a
                              href={jiraUrl(bug.key)}
                              target="_blank"
                              rel="noreferrer"
                              style={{ color: '#1a56db', fontSize: 15, fontWeight: 600, textDecoration: 'none' }}
                            >
                              {bug.key}
                            </a>
                          </td>
                          <td style={{ fontSize: 15, color: '#374151', overflowWrap: 'break-word', wordBreak: 'break-word' }}>{bug.summary}</td>
                          <td style={{ fontSize: 15, color: '#64748b', whiteSpace: 'nowrap' }}>{bug.created_at}</td>
                          <td style={{ fontSize: 15, color: '#64748b', whiteSpace: 'nowrap' }}>{bug.resolved_at}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 12 }}>
                  <span style={{ fontSize: 13, color: '#94a3b8' }}>총 {resolvedBugs.length.toLocaleString()}건 · {resolvedCurrentPage} / {resolvedTotalPages}페이지</span>
                  {resolvedTotalPages > 1 && (
                    <>
                      <button
                        onClick={() => setResolvedPage(p => Math.max(1, p - 1))} disabled={resolvedCurrentPage === 1}
                        style={{ padding: '6px 12px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', fontSize: 13, cursor: resolvedCurrentPage === 1 ? 'default' : 'pointer', color: resolvedCurrentPage === 1 ? '#cbd5e1' : '#475569' }}
                      >
                        이전
                      </button>
                      <button
                        onClick={() => setResolvedPage(p => Math.min(resolvedTotalPages, p + 1))} disabled={resolvedCurrentPage === resolvedTotalPages}
                        style={{ padding: '6px 12px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', fontSize: 13, cursor: resolvedCurrentPage === resolvedTotalPages ? 'default' : 'pointer', color: resolvedCurrentPage === resolvedTotalPages ? '#cbd5e1' : '#475569' }}
                      >
                        다음
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="section-card">
        <div className="insight-toolbar">
          <span style={{ fontSize: 12, color: '#94a3b8' }}>{syncedAt ? `동기화: ${syncedAt}` : ''}</span>
          {isAdmin && (
            <button
              onClick={handleSync}
              disabled={syncing || loading}
              style={{ padding: '8px 16px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, cursor: syncing ? 'default' : 'pointer', fontSize: 13, fontWeight: 500, color: '#374151' }}
            >
              {syncing ? '동기화 중...' : '↻ 새로고침'}
            </button>
          )}
        </div>

        {!loading && bugs.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: '#64748b' }}>상태</span>
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, color: '#374151', background: '#fff' }}
              >
                <option value="all">전체</option>
                {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: '#64748b' }}>페이지당</span>
              <select
                value={pageSize}
                onChange={e => setPageSize(Number(e.target.value))}
                style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, color: '#374151', background: '#fff' }}
              >
                {[10, 20, 50, 100].map(n => <option key={n} value={n}>{n}개씩</option>)}
              </select>
            </div>
            <span style={{ fontSize: 20, fontWeight: 700, color: NAVY }}>총 {sortedBugs.length.toLocaleString()}건</span>
          </div>
        )}

        <div className="insight-table-wrap">
          {loading ? (
            <div className="loading">조회 중...</div>
          ) : !bugs.length ? (
            <div className="empty">JIRA 이슈 없음 (자격증명을 확인하세요)</div>
          ) : !sortedBugs.length ? (
            <div className="empty">선택한 조건에 해당하는 이슈가 없습니다</div>
          ) : (
            <table style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <SortableTh label="이슈" sortKey="key" width={100} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <th style={{ fontSize: 16 }}>요약</th>
                  <SortableTh label="상태" sortKey="status" width={110} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <SortableTh label="생성일" sortKey="created_at" width={100} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <SortableTh label="경과일" sortKey="ageDays" width={90} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                </tr>
              </thead>
              <tbody>
                {pagedBugs.map(bug => (
                  <tr key={bug.key}>
                    <td>
                      <a
                        href={jiraUrl(bug.key)}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: '#1a56db', fontSize: 15, fontWeight: 600, textDecoration: 'none' }}
                      >
                        {bug.key}
                      </a>
                    </td>
                    <td style={{ fontSize: 15, color: '#374151', overflowWrap: 'break-word', wordBreak: 'break-word' }}>{bug.summary}</td>
                    <td><StatusBadge status={bug.status} /></td>
                    <td style={{ fontSize: 15, color: '#64748b', whiteSpace: 'nowrap' }}>{bug.created_at}</td>
                    <td style={{ fontSize: 15, color: isSixMonthOrMore(bug) ? '#dc2626' : '#374151', fontWeight: isSixMonthOrMore(bug) ? 700 : 400 }}>
                      {getAgeDays(bug)}일
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {!loading && sortedBugs.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 12 }}>
            <span style={{ fontSize: 13, color: '#94a3b8' }}>총 {sortedBugs.length.toLocaleString()}건 · {currentPage} / {totalPages}페이지</span>
            {totalPages > 1 && (
              <>
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}
                  style={{ padding: '6px 12px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', fontSize: 13, cursor: currentPage === 1 ? 'default' : 'pointer', color: currentPage === 1 ? '#cbd5e1' : '#475569' }}
                >
                  이전
                </button>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}
                  style={{ padding: '6px 12px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', fontSize: 13, cursor: currentPage === totalPages ? 'default' : 'pointer', color: currentPage === totalPages ? '#cbd5e1' : '#475569' }}
                >
                  다음
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
