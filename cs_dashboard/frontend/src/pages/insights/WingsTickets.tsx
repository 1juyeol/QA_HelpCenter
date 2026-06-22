// 반복 Wings 티켓 인사이트 페이지. 동일 Wings 티켓 번호가 여러 CS 건에서 언급된 목록을 테이블로 표시한다.
// 마운트 시 /api/insights/wings_tickets를 fetch하고, 새로고침 버튼은 POST /api/insights/refresh → 재조회 순서로 동작한다.
// 최초 접수일부터 7일 이상 경과한 티켓은 '처리 지연' 배지를 표시하며, 각 행을 클릭하면 CS 메모 이력을 펼쳐 볼 수 있다.
// 차트 영역: Treemap(CSS) + Scatter(경과일×CS건수) + Timeline(경과일 가로바) 3종을 다크 배경으로 표시한다.
// 이 컴포넌트 내부에서만 상태를 관리하며 다른 페이지와 상태를 공유하지 않는다 (정책 8).
import { Fragment, useEffect, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import { api, type InsightWings } from '../../api/client'

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

function StateBadge({ state, delayed, diffDays }: { state?: string; delayed: boolean; diffDays: number }) {
  if (delayed) {
    return (
      <>
        <span style={{ display: 'inline-block', background: '#fee2e2', color: '#dc2626', borderRadius: 999, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>처리 지연</span>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>{diffDays}일 경과</div>
      </>
    )
  }
  if (!state) {
    return <span style={{ display: 'inline-block', background: '#f1f5f9', color: '#64748b', borderRadius: 999, padding: '2px 8px', fontSize: 11 }}>—</span>
  }
  const s = STATE_STYLE[state] ?? { bg: '#f1f5f9', color: '#64748b' }
  return <span style={{ display: 'inline-block', background: s.bg, color: s.color, borderRadius: 999, padding: '2px 8px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>{state}</span>
}

export default function WingsTickets() {
  const [rows, setRows] = useState<InsightWings[]>([])
  const [updatedAt, setUpdatedAt] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const scatterCanvasRef = useRef<HTMLCanvasElement>(null)
  const scatterChartRef = useRef<Chart | null>(null)

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (loading || !rows.length) return

    if (scatterCanvasRef.current) {
      scatterChartRef.current?.destroy()
      scatterChartRef.current = new Chart(scatterCanvasRef.current, {
        type: 'scatter',
        data: {
          datasets: [{
            data: rows.map(r => ({ x: getDiffDays(r), y: r.cs_count })),
            backgroundColor: rows.map(r => isDelayedTicket(r) ? '#ef4444cc' : '#3b82f6cc'),
            pointRadius: rows.map(r => Math.max(6, r.cs_count * 5)),
            pointHoverRadius: rows.map(r => Math.max(8, r.cs_count * 5 + 2)),
          }],
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => {
                  const r = rows[ctx.dataIndex]
                  return `#${r.ticket_id} · CS ${r.cs_count}건 · ${getDiffDays(r)}일 경과`
                },
              },
            },
          },
          scales: {
            x: {
              title: { display: true, text: '경과일수', color: '#374151' },
              grid: { color: 'rgba(0,0,0,0.06)' },
              ticks: { color: '#374151', font: { size: 11 }, stepSize: 7 },
              min: 0,
            },
            y: {
              title: { display: true, text: 'CS 건수', color: '#374151' },
              grid: { color: 'rgba(0,0,0,0.06)' },
              ticks: { color: '#374151', font: { size: 11 }, stepSize: 2 },
              min: 0,
            },
          },
        },
      })
    }

  }, [loading, rows])

  useEffect(() => () => {
    scatterChartRef.current?.destroy()
  }, [])

  async function load() {
    setLoading(true)
    try {
      const res = await api.fetchWingsTickets()
      setRows(res.data || [])
      setUpdatedAt(res.updated_at ? `최근 30일 기준 · 업데이트: ${res.updated_at.slice(0, 16)}` : '')
    } finally {
      setLoading(false)
    }
  }

  async function handleRefresh() {
    setRefreshing(true)
    try {
      await api.refreshInsights()
      await load()
    } finally {
      setRefreshing(false)
    }
  }

  function toggleExpand(i: number) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }

  const delayedCount = rows.filter(isDelayedTicket).length

  return (
    <div className="container">
      <div className="section-card">
        <h2>반복 Wings 티켓</h2>
        <p style={{ fontSize: 13, color: '#94a3b8', marginBottom: 16 }}>
          여러 CS 건에서 동일하게 언급된 Wings 티켓 — 다수 고객에게 영향을 준 이슈를 확인할 수 있습니다.
        </p>
        <div className="insight-toolbar">
          <span style={{ fontSize: 12, color: '#94a3b8' }}>{updatedAt}</span>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            style={{ padding: '8px 16px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, cursor: refreshing ? 'default' : 'pointer', fontSize: 13, fontWeight: 500, color: '#374151' }}
          >
            {refreshing ? '업데이트 중...' : '↻ 새로고침'}
          </button>
        </div>

        {!loading && rows.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            {/* KPI 카드 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
              {[
                { label: '전체 티켓', value: rows.length, alert: false },
                { label: '처리 지연', value: delayedCount, alert: delayedCount > 0 },
                { label: '총 CS 건수', value: rows.reduce((a, r) => a + r.cs_count, 0), alert: false },
              ].map(kpi => (
                <div key={kpi.label} style={{ background: '#fff', borderRadius: 12, padding: '16px 20px', border: `1px solid ${kpi.alert ? '#fca5a5' : '#e2e8f0'}` }}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>{kpi.label}</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: kpi.alert ? '#dc2626' : '#111827' }}>{kpi.value}</div>
                </div>
              ))}
            </div>

            {/* Scatter */}
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>경과일 × CS 건수</div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 12 }}>점 크기 = CS 건수 · 빨강 = 처리 지연 (7일+)</div>
              <div style={{ height: 240 }}>
                <canvas ref={scatterCanvasRef} />
              </div>
            </div>
          </div>
        )}

        <div className="insight-table-wrap">
          {loading ? (
            <div className="loading">불러오는 중...</div>
          ) : !rows.length ? (
            <div className="empty">해당 기간에 Wings 티켓 언급 없음</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th style={{ width: 120 }}>티켓 번호</th>
                  <th style={{ width: 80 }}>CS 건수</th>
                  <th style={{ width: 90 }}>상태</th>
                  <th>최근 메모</th>
                  <th style={{ width: 130 }}>최초 접수</th>
                  <th style={{ width: 130 }}>최근 접수</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const isTop = i < 3
                  const isOpen = expanded.has(i)
                  const latestMemo = r.memos?.[0]?.memo ?? ''
                  const preview = latestMemo.replace(/\n/g, ' ').slice(0, 100)
                  const diffDays = getDiffDays(r)
                  const delayed = isDelayedTicket(r)

                  return (
                    <Fragment key={i}>
                      <tr>
                        <td><span className={`rank-badge${isTop ? ' top' : ''}`}>{i + 1}</span></td>
                        <td>
                          <a className="ticket-link" href={`https://wings.danbiedu.co.kr/#ticket/zoom/${r.ticket_id}`} target="_blank" rel="noreferrer">
                            #{r.ticket_id}
                          </a>
                        </td>
                        <td><span className="count-badge">{r.cs_count}건</span></td>
                        <td>
                          <StateBadge state={r.state} delayed={delayed} diffDays={diffDays} />
                        </td>
                        <td style={{ color: '#374151', fontSize: 13 }}>
                          {preview}{latestMemo.length > 100 ? '…' : ''}
                          {r.memos?.length > 0 && (
                            <>
                              <br />
                              <button className="memo-toggle" onClick={() => toggleExpand(i)}>
                                {isOpen ? '▼ 접기' : `▶ 전체 이력 보기 (${r.memos.length}건)`}
                              </button>
                            </>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap', color: '#64748b', fontSize: 12 }}>{r.first_date ? r.first_date.slice(0, 16) : '—'}</td>
                        <td style={{ whiteSpace: 'nowrap', color: '#64748b', fontSize: 12 }}>{r.latest_date ? r.latest_date.slice(0, 16) : '—'}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={7} style={{ padding: 0 }}>
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
    </div>
  )
}
