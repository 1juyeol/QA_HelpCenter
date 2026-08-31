// 학부모 반복 인입 인사이트 페이지. 30일 내 동일 학부모가 3회 이상 CS 인입한 목록을 표시한다.
// 단순 횟수 순이 아니라 위험도(긴급·주의·관찰)로 정렬해 미해결 가능성이 높은 학부모를 우선 확인한다.
//
// 우선순위 기준 (조건 기반):
//   긴급: 동일 이슈 반복 AND 2일 내 재인입 (미해결 가능성 가장 높음)
//   주의: 동일 이슈 반복 OR 최근 7일 내 재인입 (한 가지 위험 신호)
//   관찰: 30일 3회 이상이지만 위 조건 미해당
//
// 상단: KPI 4개 (각 모수 관계 표시) + 반복 인입 학부모 문의 유형 분포 차트
// 테이블 열: 우선순위·학부모번호·반복위험신호·인입횟수·유형수·최근접수·최근메모
//
// 의존: api/client.ts (InsightParent), api/categories.ts (ALLOWED_MAIN, isAllowedCategory 등)
import { Fragment, useEffect, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import { api, adminParentUrl, type InsightParent } from '../../api/client'
import { ALLOWED_MAIN, ALLOWED_SPECIFIC, FILTER_TREE, isAllowedCategory } from '../../api/categories'
import { useAdmin } from '../../hooks/useAdmin'

// KPI 카드 상단 컬러 바 — 반복 Wings 티켓과 달리 카드별로 색을 다르게 주지 않고 전부 이 한 색만
// 써서(정적인 느낌 요청) 화려하지 않게 유지한다. 우선순위 구분은 이미 아래 표의 배지로 하고 있다.
const NAVY = '#1e3c72'

const CATEGORY_COLORS: Record<string, string> = {
  '네트워크·앱 오류':   '#3b82f6',
  '기기·하드웨어 오류': '#f59e0b',
  '미납·결제':          '#ef4444',
  '해지·유지 상담':     '#8b5cf6',
  '교재·물류·배송':     '#10b981',
}

type ActiveFilter = { main: string | null; sub: string | null }
type PriorityLevel = 'urgent' | 'warning' | 'watch'

// ── 자격 판별 ─────────────────────────────────────────────────────────────────

function getQualifyingMemos(r: InsightParent) {
  return r.memos.filter(m => {
    const main = m.category.split(' > ')[0]
    return ALLOWED_MAIN.has(main) || ALLOWED_SPECIFIC.has(m.category)
  })
}

function isQualified(r: InsightParent): boolean {
  return getQualifyingMemos(r).length >= 3
}

// ── 패턴 판별 ─────────────────────────────────────────────────────────────────

function hasSameIssueRepeat(r: InsightParent): boolean {
  const counts: Record<string, number> = {}
  getQualifyingMemos(r).forEach(m => {
    const main = m.category.split(' > ')[0]
    counts[main] = (counts[main] ?? 0) + 1
  })
  return Object.values(counts).some(c => c >= 2)
}

function isComplexIssue(r: InsightParent): boolean {
  const mains = new Set(getQualifyingMemos(r).map(m => m.category.split(' > ')[0]))
  return mains.size >= 3
}

function hasShortGap(r: InsightParent): boolean {
  const dates = getQualifyingMemos(r)
    .map(m => new Date(m.date).getTime())
    .sort((a, b) => a - b)
  for (let i = 1; i < dates.length; i++) {
    if ((dates[i] - dates[i - 1]) / 86400000 <= 2) return true
  }
  return false
}

function getLastGapDays(r: InsightParent): number | null {
  const dates = getQualifyingMemos(r)
    .map(m => new Date(m.date).getTime())
    .sort((a, b) => b - a)
  if (dates.length < 2) return null
  return Math.floor((dates[0] - dates[1]) / 86400000)
}

// 우선순위 기준: 점수 합산 아닌 조건 기반 3단계
function getPriorityLevel(r: InsightParent): PriorityLevel {
  const sameIssue  = hasSameIssueRepeat(r)
  const shortGap   = hasShortGap(r)
  const lastGap    = getLastGapDays(r)
  const recentGap  = lastGap !== null && lastGap <= 7

  if (sameIssue && shortGap) return 'urgent'
  if (sameIssue || recentGap) return 'warning'
  return 'watch'
}

function getPriorityBadge(level: PriorityLevel): { text: string; color: string; bg: string } {
  if (level === 'urgent')  return { text: '긴급', color: '#fff',    bg: '#ef4444' }
  if (level === 'warning') return { text: '주의', color: '#fff',    bg: '#f97316' }
  return                          { text: '관찰', color: '#64748b', bg: '#f1f5f9' }
}

function priorityOrder(r: InsightParent): number {
  const l = getPriorityLevel(r)
  return l === 'urgent' ? 0 : l === 'warning' ? 1 : 2
}

// ── 필터 ──────────────────────────────────────────────────────────────────────

function memoMatches(category: string, f: ActiveFilter): boolean {
  if (!f.main) return true
  if (f.sub) return category === `${f.main} > ${f.sub}`
  if (ALLOWED_MAIN.has(f.main)) return category.startsWith(`${f.main} > `)
  return ALLOWED_SPECIFIC.has(category) && category.startsWith(`${f.main} > `)
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export default function RepeatParents() {
  const { isAdmin, adminToken } = useAdmin()
  const [data, setData]             = useState<InsightParent[]>([])
  const [updatedAt, setUpdatedAt]   = useState('')
  const [loading, setLoading]       = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter]         = useState<ActiveFilter>({ main: null, sub: null })
  const [expanded, setExpanded]     = useState<Set<number>>(new Set())

  const hbarCanvasRef = useRef<HTMLCanvasElement>(null)
  const hbarChartRef  = useRef<Chart | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const res = await api.fetchRepeatParents()
      setData((res.data || []).filter(isQualified))
      setUpdatedAt(res.updated_at ? `최근 30일 기준 · 업데이트: ${res.updated_at.slice(0, 16)}` : '')
      setFilter({ main: null, sub: null })
    } finally {
      setLoading(false)
    }
  }

  async function handleRefresh() {
    if (!adminToken) return
    setRefreshing(true)
    try {
      await api.refreshRepeatParentsInsights(adminToken)
      await load()
    } finally {
      setRefreshing(false)
    }
  }

  function selectMain(main: string) {
    setFilter(prev => prev.main === main && !prev.sub ? { main: null, sub: null } : { main, sub: null })
    setExpanded(new Set())
  }

  function selectSub(main: string, sub: string) {
    setFilter(prev => prev.sub === sub ? { main, sub: null } : { main, sub })
    setExpanded(new Set())
  }

  function toggleExpand(i: number) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }

  function getDisplayCount(r: InsightParent) {
    if (filter.main) return r.memos.filter(m => memoMatches(m.category, filter)).length
    return getQualifyingMemos(r).length
  }

  // ── 차트 ──────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (loading || !data.length) return

    const catCount: Record<string, number> = {}
    data.forEach(p => {
      p.memos.forEach(m => {
        if (!isAllowedCategory(m.category)) return
        const main = m.category.split(' > ')[0]
        catCount[main] = (catCount[main] ?? 0) + 1
      })
    })
    const labels = Object.keys(catCount).sort((a, b) => catCount[b] - catCount[a])

    if (hbarCanvasRef.current) {
      hbarChartRef.current?.destroy()
      hbarChartRef.current = new Chart(hbarCanvasRef.current, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            data: labels.map(l => catCount[l]),
            backgroundColor: labels.map(l => CATEGORY_COLORS[l] ?? '#94a3b8'),
            borderRadius: 4,
            borderSkipped: false,
          }],
        },
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { stepSize: 5, font: { size: 11 }, color: '#374151' }, grid: { color: 'rgba(0,0,0,0.06)' }, min: 0 },
            y: { ticks: { font: { size: 11 }, color: '#374151' }, grid: { display: false } },
          },
        },
      })
    }
  }, [loading, data])

  useEffect(() => () => { hbarChartRef.current?.destroy() }, [])

  // ── 집계·정렬 ────────────────────────────────────────────────────────────────

  const total           = data.length
  const sameIssueCount  = data.filter(hasSameIssueRepeat).length
  const complexCount    = data.filter(isComplexIssue).length
  const shortGapCount   = data.filter(hasShortGap).length

  const rows = [...(filter.main
    ? data.filter(r => r.memos.some(m => memoMatches(m.category, filter)))
    : data
  )].sort((a, b) => {
    const diff = priorityOrder(a) - priorityOrder(b)
    return diff !== 0 ? diff : getDisplayCount(b) - getDisplayCount(a)
  })

  // ── 렌더 ──────────────────────────────────────────────────────────────────────

  return (
    <div className="container">

      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, marginBottom: 4, fontSize: 18, fontWeight: 700, color: '#1e293b' }}>학부모 반복 인입</h2>
        <p style={{ margin: 0, fontSize: 13, color: '#94a3b8' }}>
          위험도 순 정렬 — 긴급(동일이슈 + 2일 내 재인입) · 주의(동일이슈 또는 최근 7일 내 재인입) · 관찰(그 외)
        </p>
      </div>

      {!loading && data.length > 0 && (
        <>
          {/* KPI 카드 — 모수 관계 서브텍스트 포함 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
            {[
              {
                label: '반복 인입 학부모',
                value: total,
                unit: '명',
                base: '최근 30일 3회 이상',
                sub: null,
              },
              {
                label: '동일 이슈 반복',
                value: sameIssueCount,
                unit: '명',
                base: '동일 유형 2회 이상',
                sub: `반복 인입 ${total}명 중`,
              },
              {
                label: '복합 이슈',
                value: complexCount,
                unit: '명',
                base: '문의 유형 3개 이상',
                sub: `반복 인입 ${total}명 중`,
              },
              {
                label: '단기간 재인입',
                value: shortGapCount,
                unit: '명',
                base: '2일 내 재인입',
                sub: `반복 인입 ${total}명 중`,
              },
            ].map(kpi => (
              <div key={kpi.label} style={{
                background: '#fff',
                borderRadius: 14,
                boxShadow: '0 1px 4px rgba(0,0,0,.06)',
                borderTop: `3px solid ${NAVY}`,
                padding: '16px 20px',
              }}>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>{kpi.base}</div>
                {kpi.sub && (
                  <div style={{ fontSize: 10, color: '#cbd5e1', marginBottom: 6 }}>{kpi.sub}</div>
                )}
                <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600, marginBottom: 8, marginTop: kpi.sub ? 0 : 6 }}>
                  {kpi.label}
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                  <span style={{ fontSize: 30, fontWeight: 800, color: '#1e293b' }}>{kpi.value}</span>
                  <span style={{ fontSize: 13, color: '#94a3b8' }}>{kpi.unit}</span>
                </div>
              </div>
            ))}
          </div>

          {/* 문의 유형 분포 차트 */}
          <div className="section-card" style={{ marginBottom: 16 }}>
            <h2>
              반복 인입 학부모 문의 유형 분포
              <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 400, marginLeft: 8 }}>최근 30일</span>
            </h2>
            <div style={{ height: 180 }}>
              <canvas ref={hbarCanvasRef} />
            </div>
          </div>
        </>
      )}

      {/* 테이블 */}
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

        {!loading && data.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {FILTER_TREE.map(({ main }) => (
                <button
                  key={main}
                  className={`cat-filter-btn${filter.main === main ? ' active' : ''}`}
                  onClick={() => selectMain(main)}
                >
                  {main}
                </button>
              ))}
            </div>
            {filter.main && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, paddingLeft: 4 }}>
                {FILTER_TREE.find(t => t.main === filter.main)?.subs.map(sub => (
                  <button
                    key={sub}
                    className={`cat-filter-btn${filter.sub === sub ? ' active' : ''}`}
                    style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6 }}
                    onClick={() => selectSub(filter.main!, sub)}
                  >
                    {sub}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="insight-table-wrap">
          {loading ? (
            <div className="loading">조회 중...</div>
          ) : !data.length ? (
            <div className="empty">해당 기간에 반복 인입 없음</div>
          ) : !rows.length ? (
            <div className="empty">해당 분류의 반복 인입 없음</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 64 }}>우선순위</th>
                  <th style={{ width: 120 }}>학부모 번호</th>
                  <th style={{ width: 190 }}>반복 위험 신호</th>
                  <th style={{ width: 70 }}>인입 횟수</th>
                  <th style={{ width: 58 }}>유형 수</th>
                  <th style={{ width: 130 }}>최근 접수</th>
                  <th>최근 메모</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const level    = getPriorityLevel(r)
                  const badge    = getPriorityBadge(level)
                  const isOpen   = expanded.has(i)
                  const qMemos   = filter.main
                    ? r.memos.filter(m => memoMatches(m.category, filter))
                    : getQualifyingMemos(r)
                  const latestMemo    = qMemos[0]?.memo ?? ''
                  const preview       = latestMemo.replace(/\n/g, ' ').slice(0, 50)
                  const distinctMains = new Set(getQualifyingMemos(r).map(m => m.category.split(' > ')[0]))

                  const tags: { label: string; color: string; bg: string }[] = []
                  if (hasSameIssueRepeat(r)) tags.push({ label: '동일이슈반복', color: '#1d4ed8', bg: '#dbeafe' })
                  if (isComplexIssue(r))     tags.push({ label: '복합이슈',     color: '#6d28d9', bg: '#ede9fe' })
                  if (hasShortGap(r))        tags.push({ label: '단기재인입',   color: '#b91c1c', bg: '#fee2e2' })

                  return (
                    <Fragment key={i}>
                      <tr>
                        <td>
                          <span style={{
                            display: 'inline-block',
                            padding: '3px 8px',
                            borderRadius: 6,
                            fontSize: 11,
                            fontWeight: 700,
                            color: badge.color,
                            background: badge.bg,
                          }}>
                            {badge.text}
                          </span>
                        </td>
                        <td style={{ fontSize: 13, fontWeight: 600 }}>
                          {r.parent_id
                            ? <a href={adminParentUrl(r.parent_id)} target="_blank" rel="noreferrer" style={{ color: '#1a56db', textDecoration: 'none' }}>{r.parent_id}</a>
                            : <span style={{ color: '#94a3b8' }}>비회원</span>}
                        </td>
                        <td>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {tags.map(tag => (
                              <span key={tag.label} style={{
                                fontSize: 10, fontWeight: 600,
                                padding: '2px 6px', borderRadius: 4,
                                color: tag.color, background: tag.bg,
                                whiteSpace: 'nowrap',
                              }}>
                                {tag.label}
                              </span>
                            ))}
                            {tags.length === 0 && (
                              <span style={{ fontSize: 11, color: '#cbd5e1' }}>—</span>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className="count-badge">{getDisplayCount(r)}건</span>
                        </td>
                        <td style={{ fontSize: 13, color: '#374151', textAlign: 'center' }}>
                          {distinctMains.size}
                        </td>
                        <td style={{ whiteSpace: 'nowrap', color: '#64748b', fontSize: 12 }}>
                          {qMemos[0]?.date ? qMemos[0].date.slice(0, 16) : '—'}
                        </td>
                        <td style={{ color: '#64748b', fontSize: 12, maxWidth: 0 }}>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {preview}{latestMemo.length > 50 ? '…' : ''}
                          </div>
                          {qMemos.length > 0 && (
                            <button className="memo-toggle" onClick={() => toggleExpand(i)} style={{ marginTop: 2 }}>
                              {isOpen ? '▼ 접기' : `▶ 전체 이력 (${qMemos.length}건)`}
                            </button>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={7} style={{ padding: 0 }}>
                            <div className="memo-expand-inner">
                              {qMemos.map((m, mi) => (
                                <div key={mi} className="memo-item">
                                  <div className="memo-item-date">{m.date ? m.date.slice(0, 16) : '—'} · {m.category || ''}</div>
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
