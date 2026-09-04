// Wings 티켓 모니터링 페이지. 공감센터 상담에 한 번이라도 언급된 Wings A/S 티켓을 전부 모아
// 보여준다. 마운트 시 /api/insights/wings_tickets(미해결만)·/api/insights/wings_summary
// (전체·해결 건수)·/api/insights/wings_delay_trend(7일+/30일+ 지연 건수 일별 스냅샷)를 같이
// fetch하고, 새로고침 버튼(관리자 전용)은 POST /api/insights/refresh/wings → 재조회 순서로
// 동작한다(학부모 반복 상담 캐시는 안 건드린다 — 둘은 이제 독립적으로 갱신된다).
// KPI 카드 4개 — 미해결 티켓(현재 미해결 기준, 클릭하면 필터 해제) / 2회 이상 상담(같은 티켓
// 재문의) / 7일 이상 처리 지연 / 30일 이상 처리 지연. 뒤 세 개는 서로 독립적인 기준이라 겹칠
// 수 있고, 클릭하면 아래 표가 그 조건으로 필터링된다(CardFilter, CARD_PREDICATE 참고).
// 처리 지연 건수 추이(7일+/30일+ 스냅샷을 주 단위로 묶은 선 그래프) → 가정별 이탈 위험
// 섹션(CaseRiskSection.tsx, 같은 rows를 그대로 넘겨 카테고리별 분포·주간 추이로 재구성) →
// 상세 테이블(학생·학부모·카테고리·경과일·상태·마지막 상담 언급 포함, 컬럼 헤더 클릭으로
// 정렬) 순으로 구성된다. 기본 정렬은 상담 건수 내림차순 → 동률이면 경과일 내림차순(compareRows
// 참고). 이 컴포넌트 내부에서만 상태를 관리하며 다른 페이지와 상태를 공유하지 않는다(정책 8).
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Chart from 'chart.js/auto'
import { api, adminStudentUrl, adminParentUrl, type InsightWings, type WingsDelaySnapshot } from '../../api/client'
import CaseRiskSection from './CaseRiskSection'
import { useAdmin } from '../../hooks/useAdmin'

// KPI 카드 상단 컬러 바 — 일간/주간보고서 KpiCard와 같은 팔레트를 그대로 쓴다
// (NAVY=전체/중립, AMBER=초기 경고, RISK_RED=가장 심각, PURPLE=시간 축과 무관한 반복·복합 신호).
const NAVY = '#1e3c72'
const AMBER = '#f59e0b'
const RISK_RED = '#ef4444'
const PURPLE = '#8b5cf6'

const STATE_STYLE: Record<string, { bg: string; color: string }> = {
  '신규':        { bg: '#eff6ff', color: '#1a56db' },
  '진행 중':     { bg: '#fef9c3', color: '#b45309' },
  '결과 확인 중':{ bg: '#fef9c3', color: '#b45309' },
  '해결':        { bg: '#dcfce7', color: '#15803d' },
  '요청취소':    { bg: '#f1f5f9', color: '#64748b' },
  'merged':      { bg: '#f1f5f9', color: '#64748b' },
}

function getDiffDays(r: InsightWings): number {
  if (!r.first_date) return 0
  return Math.floor((Date.now() - new Date(r.first_date).getTime()) / 86400000)
}

function isDelayedTicket(r: InsightWings): boolean {
  const closed = r.state === '해결' || r.state === '요청취소' || r.state === 'merged'
  return getDiffDays(r) >= 7 && !closed
}

function isLongUnresolvedTicket(r: InsightWings): boolean {
  const closed = r.state === '해결' || r.state === '요청취소' || r.state === 'merged'
  return getDiffDays(r) >= 30 && !closed
}

export function isRepeatTicket(r: InsightWings): boolean {
  return r.cs_count > 1
}

const CLOSED_STATES = new Set(['해결', '요청취소', 'merged'])
function isClosedTicket(r: InsightWings): boolean {
  return !!r.state && CLOSED_STATES.has(r.state)
}

// snapshot_date(YYYY-MM-DD)가 속한 주의 월요일 — 처리 지연 추이 차트의 주 단위 버킷 키로
// 쓴다 (CaseRiskSection.tsx의 weekStartOf와 같은 방식).
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

// 같은 주에 스냅샷이 여러 개 쌓였으면(수동 새로고침 등) 그 주의 마지막(가장 최근) 값을
// 그 주의 대표값으로 쓴다 — snapshot_date가 이미 오름차순으로 온다고 가정한다.
function groupSnapshotsByWeek(snapshots: WingsDelaySnapshot[]): { week: string; delayed7: number; delayed30: number }[] {
  const byWeek = new Map<string, WingsDelaySnapshot>()
  for (const s of snapshots) {
    byWeek.set(weekStartOf(s.snapshot_date), s)
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, s]) => ({ week, delayed7: s.delayed_7_count, delayed30: s.delayed_30_count }))
}

// '미해결'/'전체'/'해결'은 상태를 묶어서 보는 편의 옵션이고, 그 외 값은 실제 티켓 상태
// 원문(신규/진행 중/결과 확인 중/해결/요청취소/merged 등)을 그대로 쓴다 — 두 종류를 같은
// 드롭다운에 같이 두되 "해결"은 이미 편의 옵션에 있으므로 원문 목록에서는 제외한다(중복 방지).
type TicketStateFilter = string
export function matchesStateFilter(r: InsightWings, filter: TicketStateFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'unresolved') return !isClosedTicket(r)
  if (filter === 'resolved') return isClosedTicket(r)
  return r.state === filter
}

// KPI 카드 클릭 필터. 'all'은 필터 없음(전체 보기) — 세 조건은 서로 겹칠 수 있다
// (예: 40일 지났고 재문의도 2회인 티켓은 처리 지연·여러번 상담·장기미해결 셋 다 해당).
type CardFilter = 'all' | 'delayed' | 'repeat' | 'longUnresolved'
const CARD_FILTER_VALUES: CardFilter[] = ['all', 'delayed', 'repeat', 'longUnresolved']

const CARD_PREDICATE: Record<Exclude<CardFilter, 'all'>, (r: InsightWings) => boolean> = {
  delayed: isDelayedTicket,
  repeat: isRepeatTicket,
  longUnresolved: isLongUnresolvedTicket,
}

type SortKey = 'ticket_id' | 'parent_id' | 'category' | 'cs_count' | 'diffDays' | 'state' | 'first_date' | 'latest_date'

function getSortValue(r: InsightWings, key: SortKey): number | string {
  switch (key) {
    case 'ticket_id': return Number(r.ticket_id)
    case 'parent_id': return r.parent_id ?? -1
    case 'category': return r.category ?? '미분류'
    case 'cs_count': return r.cs_count
    case 'diffDays': return getDiffDays(r)
    case 'state': return r.state ?? ''
    case 'first_date': return r.first_date ?? ''
    case 'latest_date': return r.latest_date ?? ''
  }
}

// 기본 정렬 기준(상담 건수)일 때만 동률을 경과일로 다시 가른다 — "상담 건수 1순위, 동일하면
// 경과일 2순위" 요건. 다른 컬럼을 클릭해 정렬 기준을 바꾸면 그 컬럼 하나로만 정렬한다.
export function compareRows(a: InsightWings, b: InsightWings, key: SortKey, dir: 'asc' | 'desc'): number {
  const av = getSortValue(a, key)
  const bv = getSortValue(b, key)
  let cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'ko')
  if (cmp === 0 && key === 'cs_count') {
    cmp = getDiffDays(a) - getDiffDays(b)
  }
  return dir === 'desc' ? -cmp : cmp
}

function SortableTh({
  label, sortKey: key, width, currentKey, currentDir, onSort,
}: {
  label: string; sortKey: SortKey; width?: number
  currentKey: SortKey; currentDir: 'asc' | 'desc'; onSort: (key: SortKey) => void
}) {
  const active = currentKey === key
  // 화살표를 활성 컬럼에서만 렌더링하면, 정렬 기준이 바뀔 때마다 그 컬럼의 텍스트 폭이
  // 달라져 글자가 옆으로 밀리거나 줄바꿈됐다 — 비활성 상태에도 옅은 색 화살표를 항상
  // 자리 잡아둬서 폭이 절대 변하지 않게 하고, 동시에 "정렬 가능/현재 기준"을 한눈에 보여준다.
  return (
    <th style={{ width, cursor: 'pointer', userSelect: 'none', fontSize: 16 }} onClick={() => onSort(key)}>
      {label}
      <span style={{ marginLeft: 3, color: active ? '#1a56db' : '#cbd5e1', fontWeight: active ? 700 : 400 }}>
        {active ? (currentDir === 'desc' ? '▼' : '▲') : '▼'}
      </span>
    </th>
  )
}

function StateBadge({ state, delayed, longUnresolved }: { state?: string; delayed: boolean; longUnresolved: boolean }) {
  // longUnresolved(30일+)는 delayed(7일+)를 항상 포함하므로(부분집합), 뱃지는 둘 다 표시하지
  // 않고 longUnresolved를 먼저 확인해 더 심각한 쪽 하나만 보여준다.
  if (longUnresolved) {
    return (
      <span style={{ display: 'inline-block', background: '#fee2e2', color: '#ef4444', borderRadius: 12, padding: '2px 8px', fontSize: 13, fontWeight: 700, lineHeight: 1.4, textAlign: 'center' }}>
        30일 이상<br />처리 지연
      </span>
    )
  }
  if (delayed) {
    return (
      <span style={{ display: 'inline-block', background: '#fee2e2', color: '#ef4444', borderRadius: 12, padding: '2px 8px', fontSize: 13, fontWeight: 700, lineHeight: 1.4, textAlign: 'center' }}>
        7일 이상<br />처리 지연
      </span>
    )
  }
  if (!state) {
    return <span style={{ display: 'inline-block', background: '#f1f5f9', color: '#64748b', borderRadius: 999, padding: '2px 8px', fontSize: 13 }}>—</span>
  }
  const s = STATE_STYLE[state] ?? { bg: '#f1f5f9', color: '#64748b' }
  return <span style={{ display: 'inline-block', background: s.bg, color: s.color, borderRadius: 999, padding: '2px 8px', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>{state}</span>
}

export default function WingsTickets() {
  const { isAdmin, adminToken } = useAdmin()
  const [searchParams] = useSearchParams()
  const [rows, setRows] = useState<InsightWings[]>([])
  const [delayTrend, setDelayTrend] = useState<WingsDelaySnapshot[]>([])
  const [summary, setSummary] = useState({ total: 0, resolved: 0 })
  const [updatedAt, setUpdatedAt] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [sortKey, setSortKey] = useState<SortKey>('cs_count')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  // 주간보고서의 "장기미해결 상담 현황" 카드(?filter=)로 들어온 경우 그 카드가 바로
  // 선택된 상태로 시작한다.
  const [cardFilter, setCardFilter] = useState<CardFilter>(() => {
    const f = searchParams.get('filter')
    return (CARD_FILTER_VALUES as string[]).includes(f ?? '') ? (f as CardFilter) : 'all'
  })
  // 카드와 무관하게 항상 노출되는 상태 필터. 카드 필터와 별개(AND)로 적용된다.
  const [stateFilter, setStateFilter] = useState<TicketStateFilter>('unresolved')
  // 티켓 캡을 없앤 뒤로 표가 최대 1,600여 건까지 나올 수 있어 페이지네이션이 필요해졌다.
  const [pageSize, setPageSize] = useState(50)
  const [page, setPage] = useState(1)

  // 2회 이상 상담·7일 이상 처리 지연·30일 이상 처리 지연 세 카드와 처리 지연 추이 차트,
  // 가정별 이탈 위험 섹션은 전부 "아직 안 풀린 건"만 다루는 게 이 페이지의 원래 취지라 해결된
  // 티켓을 제외한 목록을 기준으로 삼는다. "미해결 티켓" 카드만 전체(해결 포함) 중에서 고른다.
  const unresolvedRows = useMemo(() => rows.filter(r => !isClosedTicket(r)), [rows])

  // 드롭다운에 추가로 나열할 실제 티켓 상태 원문 — "해결"은 이미 상단 편의 옵션에 있어 제외한다.
  const rawStateOptions = useMemo(
    () => [...new Set(rows.map(r => r.state).filter((s): s is string => !!s && s !== '해결'))].sort((a, b) => a.localeCompare(b, 'ko')),
    [rows],
  )

  const cardFilteredRows = useMemo(
    () => cardFilter === 'all' ? rows : unresolvedRows.filter(CARD_PREDICATE[cardFilter]),
    [rows, unresolvedRows, cardFilter],
  )

  const filteredRows = useMemo(
    () => cardFilteredRows.filter(r => matchesStateFilter(r, stateFilter)),
    [cardFilteredRows, stateFilter],
  )

  const sortedRows = useMemo(
    () => [...filteredRows].sort((a, b) => compareRows(a, b, sortKey, sortDir)),
    [filteredRows, sortKey, sortDir],
  )

  useEffect(() => { setPage(1) }, [cardFilter, stateFilter, pageSize])

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pagedRows = sortedRows.slice((currentPage - 1) * pageSize, currentPage * pageSize)

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
  // 주간보고서 "장기미해결 상담 현황" 카드(?filter=)를 눌러 들어온 경우 — 브라우저는 페이지
  // 이동 시 스크롤 위치를 초기화해주지 않아서, 주간보고서에서 내려가 있던 위치 그대로 이
  // 페이지에 도착해 표 중간 어딘가에 놓이게 된다. 카드 링크로 들어온 최초 한 번만 차트
  // 위치로 스크롤해서 맞춰준다.
  const cameFromCardLink = useRef(searchParams.get('filter') !== null)

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (!loading && rows.length > 0 && cameFromCardLink.current) {
      cameFromCardLink.current = false
      requestAnimationFrame(() => chartSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }, [loading, rows])

  // 최근 3개월(12주)치만 보여준다 — 백엔드는 최근 100일치를 넘겨주지만, 그보다 오래된 주까지
  // 다 그리면 추이를 읽기 어렵다.
  const weeklyTrend = useMemo(() => groupSnapshotsByWeek(delayTrend).slice(-12), [delayTrend])

  useEffect(() => {
    if (loading || weeklyTrend.length < 2 || !trendCanvasRef.current) return

    trendChartRef.current?.destroy()
    trendChartRef.current = new Chart(trendCanvasRef.current, {
      type: 'line',
      data: {
        labels: weeklyTrend.map(w => w.week.slice(5).replace('-', '/')),
        datasets: [
          {
            label: '7일 이상 처리 지연', data: weeklyTrend.map(w => w.delayed7),
            borderColor: AMBER, backgroundColor: AMBER, tension: 0.2,
          },
          {
            label: '30일 이상 처리 지연', data: weeklyTrend.map(w => w.delayed30),
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

  useEffect(() => () => {
    trendChartRef.current?.destroy()
  }, [])

  async function load() {
    setLoading(true)
    try {
      const [res, summaryRes, trendRes] = await Promise.all([
        api.fetchWingsTickets(), api.fetchWingsSummary(), api.fetchWingsDelayTrend(),
      ])
      setRows(res.data || [])
      setSummary({ total: summaryRes.total, resolved: summaryRes.resolved })
      setDelayTrend(trendRes.data || [])
      setUpdatedAt(res.updated_at ? `업데이트: ${res.updated_at.slice(0, 16)}` : '')
    } finally {
      setLoading(false)
    }
  }

  async function handleRefresh() {
    if (!adminToken) return
    setRefreshing(true)
    try {
      await api.refreshWingsInsights(adminToken)
      await load()
    } finally {
      setRefreshing(false)
    }
  }

  function toggleExpand(ticketId: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(ticketId) ? next.delete(ticketId) : next.add(ticketId)
      return next
    })
  }

  const delayedCount = unresolvedRows.filter(isDelayedTicket).length
  const longUnresolvedCount = unresolvedRows.filter(isLongUnresolvedTicket).length
  const repeatCount = unresolvedRows.filter(isRepeatTicket).length

  const cards: Array<{ key: CardFilter; label: string; value: number; color: string }> = [
    { key: 'all', label: '미해결 티켓', value: unresolvedRows.length, color: NAVY },
    { key: 'repeat', label: '2회 이상 상담', value: repeatCount, color: PURPLE },
    { key: 'delayed', label: '7일 이상 처리 지연', value: delayedCount, color: AMBER },
    { key: 'longUnresolved', label: '30일 이상 처리 지연', value: longUnresolvedCount, color: RISK_RED },
  ]

  return (
    <div className="container">
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, marginBottom: 4, fontSize: 24, fontWeight: 700, color: '#1e293b' }}>반복 Wings 티켓</h2>
        <p style={{ margin: 0, fontSize: 18, color: '#94a3b8' }}>
          상담에서 확인된 Wings A/S 티켓 현황입니다. 카드를 선택하면 해당 조건의 미해결 건을 확인할 수 있습니다.
        </p>
      </div>
      {!loading && (rows.length > 0 || summary.total > 0) && (
        <div style={{ marginBottom: 20 }}>
            {/* KPI 카드 — 클릭하면 아래 표가 그 조건으로 필터링된다. "미해결 티켓"은 필터 해제(전체 보기) 역할 */}
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
                        ? `0 0 0 2px ${card.color}, 0 4px 14px ${card.color}40`
                        : '0 1px 4px rgba(0,0,0,.07)',
                      borderLeft: `4px solid ${card.color}`,
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
              각 카드는 독립적인 기준이며, 하나의 티켓이 여러 카드에 중복 반영될 수 있습니다.
            </div>

            {/* 처리 지연 주간 추이 */}
            <div ref={chartSectionRef} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#1e293b', marginBottom: 12 }}>처리 지연 건수 추이</div>
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
          </div>
        )}

      <CaseRiskSection rows={unresolvedRows} />

      <div className="section-card">
        <div className="insight-toolbar">
          <span style={{ fontSize: 12, color: '#94a3b8' }}>{updatedAt}</span>
          {isAdmin && (
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              style={{ padding: '8px 16px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, cursor: refreshing ? 'default' : 'pointer', fontSize: 13, fontWeight: 500, color: '#374151' }}
            >
              {refreshing ? '업데이트 중...' : '↻ 새로고침'}
            </button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, color: '#64748b' }}>상태</span>
            <select
              value={stateFilter}
              onChange={e => setStateFilter(e.target.value)}
              style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, color: '#374151', background: '#fff' }}
            >
              <option value="unresolved">미해결</option>
              <option value="all">전체</option>
              <option value="resolved">해결</option>
              {rawStateOptions.map(s => <option key={s} value={s}>{s}</option>)}
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
          <span style={{ fontSize: 20, fontWeight: 700, color: NAVY }}>총 {sortedRows.length.toLocaleString()}건</span>
        </div>

        <div className="insight-table-wrap">
          {loading ? (
            <div className="loading">조회 중...</div>
          ) : !rows.length ? (
            <div className="empty">Wings 티켓 언급 없음</div>
          ) : !sortedRows.length ? (
            <div className="empty">선택한 조건에 해당하는 티켓이 없습니다</div>
          ) : (
            <table style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <SortableTh label="티켓 번호" sortKey="ticket_id" width={85} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <th style={{ width: 70, fontSize: 16 }}>학생번호</th>
                  <SortableTh label="학부모번호" sortKey="parent_id" width={70} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <SortableTh label="카테고리" sortKey="category" width={120} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <SortableTh label="상담 건수" sortKey="cs_count" width={70} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <SortableTh label="경과일" sortKey="diffDays" width={50} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <SortableTh label="상태" sortKey="state" width={110} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <th style={{ width: 290, fontSize: 16 }}>상담 메모</th>
                  <SortableTh label="최초 상담" sortKey="first_date" width={90} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <SortableTh label="마지막 상담" sortKey="latest_date" width={90} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                </tr>
              </thead>
              <tbody>
                {pagedRows.map(r => {
                  const isOpen = expanded.has(r.ticket_id)
                  const latestMemo = r.memos?.[0]?.memo ?? ''
                  const preview = latestMemo.replace(/\n/g, ' ').slice(0, 100)
                  const diffDays = getDiffDays(r)
                  const delayed = isDelayedTicket(r)

                  return (
                    <Fragment key={r.ticket_id}>
                      <tr>
                        <td>
                          <a className="ticket-link" href={`https://wings.danbiedu.co.kr/#ticket/zoom/${r.ticket_id}`} target="_blank" rel="noreferrer">
                            #{r.ticket_id}
                          </a>
                        </td>
                        <td style={{ fontSize: 15 }}>
                          {r.student_id
                            ? <a href={adminStudentUrl(r.student_id)} target="_blank" rel="noreferrer" style={{ color: '#1a56db', textDecoration: 'none' }}>{r.student_id}</a>
                            : <span style={{ color: '#374151' }}>—</span>}
                        </td>
                        <td style={{ fontSize: 15 }}>
                          {r.parent_id
                            ? <a href={adminParentUrl(String(r.parent_id))} target="_blank" rel="noreferrer" style={{ color: '#1a56db', textDecoration: 'none' }}>{r.parent_id}</a>
                            : <span style={{ color: '#374151' }}>—</span>}
                        </td>
                        <td style={{ color: '#374151', fontSize: 15 }}>{r.category ?? '미분류'}</td>
                        <td><span className="count-badge">{r.cs_count}건</span></td>
                        <td style={{ color: delayed ? '#dc2626' : '#374151', fontSize: 15, fontWeight: delayed ? 700 : 400 }}>{diffDays}일</td>
                        <td>
                          <StateBadge state={r.state} delayed={delayed} longUnresolved={isLongUnresolvedTicket(r)} />
                        </td>
                        <td style={{ color: '#374151', fontSize: 15, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                          {preview}{latestMemo.length > 100 ? '…' : ''}
                          {r.memos?.length > 0 && (
                            <>
                              <br />
                              <button className="memo-toggle" onClick={() => toggleExpand(r.ticket_id)}>
                                {isOpen ? '▼ 접기' : '▶ 전체 이력 보기'}
                              </button>
                            </>
                          )}
                        </td>
                        <td style={{ color: '#64748b', fontSize: 15 }}>{r.first_date ? r.first_date.slice(0, 16) : '—'}</td>
                        <td style={{ color: '#64748b', fontSize: 15 }}>{r.latest_date ? r.latest_date.slice(0, 16) : '—'}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={10} style={{ padding: 0 }}>
                            <div className="memo-expand-inner">
                              {r.memos.map((m, mi) => (
                                <div key={mi} className="memo-item">
                                  <div className="memo-item-date">{m.date ? m.date.slice(0, 16) : '—'}</div>
                                  <div>{m.memo ? m.memo.split('\n').map((line, li) => <span key={li}>{li > 0 && <br />}{line}</span>) : ''}</div>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {!loading && sortedRows.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 12 }}>
            <span style={{ fontSize: 13, color: '#94a3b8' }}>총 {sortedRows.length.toLocaleString()}건 · {currentPage} / {totalPages}페이지</span>
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
