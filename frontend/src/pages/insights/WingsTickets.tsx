// Wings 티켓 모니터링 페이지. 공감센터 CS에 한 번이라도 언급된 Wings A/S 티켓을 전부 모아
// 보여준다. 마운트 시 /api/insights/wings_tickets(미해결만)와 /api/insights/wings_summary
// (전체·해결 건수)를 같이 fetch하고, 새로고침 버튼(관리자 전용)은 POST /api/insights/refresh/wings
// → 재조회 순서로 동작한다(학부모 반복 인입 캐시는 안 건드린다 — 둘은 이제 독립적으로 갱신된다).
// KPI 카드 4개 — 전체 티켓(해결 건수 포함, 클릭하면 필터 해제) / 처리 지연(7일+) /
// 여러번 인입(같은 티켓 2회+) / 장기미해결(30일+). 뒤 세 개는 서로 독립적인 기준이라 겹칠 수
// 있고, 클릭하면 아래 표가 그 조건으로 필터링된다(CardFilter, CARD_PREDICATE 참고).
// 버블 차트(X=경과일, Y=재언급수, 크기=전체CS건수, 항상 미해결 전체 기준 — 카드 필터 영향 안 받음),
// 상세 테이블(학부모·카테고리·경과일·관리상태·마지막CS언급 포함, 컬럼 헤더 클릭으로 정렬)로 구성된다.
// 기본 정렬은 CS 건수 내림차순 → 동률이면 경과일 내림차순(compareRows 참고).
// 이 컴포넌트 내부에서만 상태를 관리하며 다른 페이지와 상태를 공유하지 않는다 (정책 8).
//
// 하단에 별도 섹션(CaseRiskSection.tsx)이 붙는다 — 같은 rows(InsightWings[])를 그대로 넘겨
// 카테고리별 분포·주간 추이로 다시 보여준다. 이 페이지가 이미 fetch한 데이터를 그대로 넘기므로
// 그 섹션이 API를 또 호출하지 않고, "새로고침"도 자동으로 같이 반영된다.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import { api, adminStudentUrl, adminParentUrl, type InsightWings } from '../../api/client'
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

type TicketStateFilter = 'unresolved' | 'all' | 'resolved'
const STATE_FILTER_PREDICATE: Record<TicketStateFilter, (r: InsightWings) => boolean> = {
  unresolved: r => !isClosedTicket(r),
  all: () => true,
  resolved: isClosedTicket,
}

// KPI 카드 클릭 필터. 'all'은 필터 없음(전체 보기) — 세 조건은 서로 겹칠 수 있다
// (예: 40일 지났고 재문의도 2회인 티켓은 처리 지연·여러번 인입·장기미해결 셋 다 해당).
type CardFilter = 'all' | 'delayed' | 'repeat' | 'longUnresolved'

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

// 기본 정렬 기준(CS 건수)일 때만 동률을 경과일로 다시 가른다 — "CS 건수 1순위, 동일하면
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
  return (
    <th style={{ width, cursor: 'pointer', userSelect: 'none', fontSize: 16 }} onClick={() => onSort(key)}>
      {label}{active && <span style={{ marginLeft: 3, color: '#1a56db' }}>{currentDir === 'desc' ? '▼' : '▲'}</span>}
    </th>
  )
}

function StateBadge({ state, delayed, diffDays }: { state?: string; delayed: boolean; diffDays: number }) {
  if (delayed) {
    return (
      <>
        <span style={{ display: 'inline-block', background: '#fee2e2', color: '#ef4444', borderRadius: 999, padding: '2px 8px', fontSize: 13, fontWeight: 700 }}>처리 지연</span>
        <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 3 }}>{diffDays}일 경과</div>
      </>
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
  const [rows, setRows] = useState<InsightWings[]>([])
  const [summary, setSummary] = useState({ total: 0, resolved: 0 })
  const [updatedAt, setUpdatedAt] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [sortKey, setSortKey] = useState<SortKey>('cs_count')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [cardFilter, setCardFilter] = useState<CardFilter>('all')
  // "전체 티켓" 카드(cardFilter === 'all')에서만 쓰는 상태 필터 — 다른 세 카드(처리 지연·
  // 여러번 인입·장기미해결)는 정의상 미해결 건만 다루므로 이 필터의 영향을 받지 않는다.
  const [stateFilter, setStateFilter] = useState<TicketStateFilter>('unresolved')

  // 처리 지연·여러번 인입·장기미해결 세 카드와 버블 차트, 하단 "가정별 이탈 위험" 섹션은
  // 전부 "아직 안 풀린 건"만 다루는 게 이 페이지의 원래 취지라 해결된 티켓을 제외한 목록을
  // 기준으로 삼는다. "전체 티켓" 카드만 stateFilter로 해결 건까지 선택해서 볼 수 있다.
  const unresolvedRows = useMemo(() => rows.filter(r => !isClosedTicket(r)), [rows])

  const filteredRows = useMemo(
    () => cardFilter === 'all'
      ? rows.filter(STATE_FILTER_PREDICATE[stateFilter])
      : unresolvedRows.filter(CARD_PREDICATE[cardFilter]),
    [rows, unresolvedRows, cardFilter, stateFilter],
  )

  const sortedRows = useMemo(
    () => [...filteredRows].sort((a, b) => compareRows(a, b, sortKey, sortDir)),
    [filteredRows, sortKey, sortDir],
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

  const scatterCanvasRef = useRef<HTMLCanvasElement>(null)
  const scatterChartRef = useRef<Chart | null>(null)

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (loading || !unresolvedRows.length) return

    if (scatterCanvasRef.current) {
      scatterChartRef.current?.destroy()
      scatterChartRef.current = new Chart(scatterCanvasRef.current, {
        type: 'bubble',
        data: {
          datasets: [{
            data: unresolvedRows.map(r => ({
              x: getDiffDays(r),
              y: Math.max(0, r.cs_count - 1),
              r: Math.max(5, r.cs_count * 4),
            })),
            backgroundColor: unresolvedRows.map(r => isDelayedTicket(r) ? '#ef4444cc' : '#3b82f6cc'),
          }],
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => {
                  const r = unresolvedRows[ctx.dataIndex]
                  return `#${r.ticket_id} · 전체 ${r.cs_count}건 · 재언급 ${r.cs_count - 1}건 · ${getDiffDays(r)}일 경과`
                },
              },
            },
          },
          scales: {
            x: {
              title: { display: true, text: '경과일수', color: '#374151' },
              grid: { color: 'rgba(0,0,0,0.06)' },
              ticks: { color: '#374151', font: { size: 13 }, stepSize: 7 },
              min: 0,
            },
            y: {
              title: { display: true, text: '재언급 수', color: '#374151' },
              grid: { color: 'rgba(0,0,0,0.06)' },
              ticks: { color: '#374151', font: { size: 13 }, stepSize: 1 },
              min: 0,
            },
          },
        },
      })
    }

  }, [loading, unresolvedRows])

  useEffect(() => () => {
    scatterChartRef.current?.destroy()
  }, [])

  async function load() {
    setLoading(true)
    try {
      const [res, summaryRes] = await Promise.all([api.fetchWingsTickets(), api.fetchWingsSummary()])
      setRows(res.data || [])
      setSummary({ total: summaryRes.total, resolved: summaryRes.resolved })
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
    { key: 'all', label: '전체 티켓', value: summary.total, color: NAVY },
    { key: 'delayed', label: '처리 지연 (7일+)', value: delayedCount, color: AMBER },
    { key: 'repeat', label: '여러번 인입 (2회+)', value: repeatCount, color: PURPLE },
    { key: 'longUnresolved', label: '장기미해결 (30일+)', value: longUnresolvedCount, color: RISK_RED },
  ]

  return (
    <div className="container">
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, marginBottom: 4, fontSize: 24, fontWeight: 700, color: '#1e293b' }}>반복 Wings 티켓</h2>
        <p style={{ margin: 0, fontSize: 18, color: '#94a3b8' }}>
          공감센터 CS 상담 중 한 번이라도 언급된 Wings A/S 티켓을 전부 모았습니다. 그중 아직
          해결되지 않은 티켓을 처리 지연·여러번 인입·장기미해결 세 가지 기준으로 나누어 볼 수
          있고, 카드를 클릭하면 그 조건에 맞는 티켓만 아래 표에 보여줍니다.
        </p>
      </div>
      {!loading && (rows.length > 0 || summary.total > 0) && (
        <div style={{ marginBottom: 20 }}>
            {/* KPI 카드 — 클릭하면 아래 표가 그 조건으로 필터링된다. "전체 티켓"은 필터 해제(전체 보기) 역할 */}
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
                    <div style={{ fontSize: 45, fontWeight: 800, color: '#0f172a', lineHeight: 1 }}>{card.value}건</div>
                  </button>
                )
              })}
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 16 }}>
              처리 지연·여러번 인입·장기미해결은 서로 독립적인 기준이라 하나의 티켓이 여러 카드에
              동시에 해당될 수 있습니다(예: 30일 넘게 안 풀렸고 재문의도 여러 번 있었던 티켓은
              처리 지연·여러번 인입·장기미해결에 전부 포함됩니다).
            </div>

            {/* Scatter */}
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>오래될수록 오른쪽 · 재언급 많을수록 위쪽 · 버블 클수록 CS 건수 많음</div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 12 }}>빨강 = 접수 후 7일 이상 미해결</div>
              <div style={{ height: 240 }}>
                <canvas ref={scatterCanvasRef} />
              </div>
            </div>
          </div>
        )}

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

        {cardFilter === 'all' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 13, color: '#64748b' }}>상태</span>
            <select
              value={stateFilter}
              onChange={e => setStateFilter(e.target.value as TicketStateFilter)}
              style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, color: '#374151', background: '#fff' }}
            >
              <option value="unresolved">미해결</option>
              <option value="all">전체</option>
              <option value="resolved">해결</option>
            </select>
          </div>
        )}

        <div className="insight-table-wrap">
          {loading ? (
            <div className="loading">조회 중...</div>
          ) : !rows.length ? (
            <div className="empty">Wings 티켓 언급 없음</div>
          ) : !sortedRows.length ? (
            <div className="empty">선택한 조건에 해당하는 티켓이 없습니다</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 40, fontSize: 16 }}>#</th>
                  <SortableTh label="티켓 번호" sortKey="ticket_id" width={110} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <th style={{ width: 110, fontSize: 16 }}>학생</th>
                  <SortableTh label="학부모" sortKey="parent_id" width={120} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <SortableTh label="카테고리" sortKey="category" width={120} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <SortableTh label="CS 건수" sortKey="cs_count" width={80} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <SortableTh label="경과일" sortKey="diffDays" width={70} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <SortableTh label="관리상태" sortKey="state" width={90} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <th style={{ fontSize: 16 }}>최근 메모</th>
                  <SortableTh label="최초 접수" sortKey="first_date" width={120} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <SortableTh label="마지막 CS" sortKey="latest_date" width={120} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r, i) => {
                  const isTop = i < 3
                  const isOpen = expanded.has(r.ticket_id)
                  const latestMemo = r.memos?.[0]?.memo ?? ''
                  const preview = latestMemo.replace(/\n/g, ' ').slice(0, 100)
                  const diffDays = getDiffDays(r)
                  const delayed = isDelayedTicket(r)

                  return (
                    <Fragment key={r.ticket_id}>
                      <tr>
                        <td><span className={`rank-badge${isTop ? ' top' : ''}`}>{i + 1}</span></td>
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
                          <StateBadge state={r.state} delayed={delayed} diffDays={diffDays} />
                        </td>
                        <td style={{ color: '#374151', fontSize: 15 }}>
                          {preview}{latestMemo.length > 100 ? '…' : ''}
                          {r.memos?.length > 0 && (
                            <>
                              <br />
                              <button className="memo-toggle" onClick={() => toggleExpand(r.ticket_id)}>
                                {isOpen ? '▼ 접기' : `▶ 전체 이력 보기 (${r.memos.length}건)`}
                              </button>
                            </>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap', color: '#64748b', fontSize: 15 }}>{r.first_date ? r.first_date.slice(0, 16) : '—'}</td>
                        <td style={{ whiteSpace: 'nowrap', color: '#64748b', fontSize: 15 }}>{r.latest_date ? r.latest_date.slice(0, 16) : '—'}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={11} style={{ padding: 0 }}>
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
      </div>

      <CaseRiskSection rows={unresolvedRows} />
    </div>
  )
}
