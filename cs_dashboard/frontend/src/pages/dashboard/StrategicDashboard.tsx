// 전략 대시보드 (홈). 팀장·상급자 보고용 주간 CS 운영 브리핑 페이지.
// "10초 안에 이번 주 운영 상태와 핵심 리스크"를 파악할 수 있도록 정보 계층을 구성한다.
//
// 레이아웃 (위→아래):
//   1. 네이비 브리핑 영역
//      - 헤더: 기간 + 업데이트 시점
//      - 리스크 알림 배너: 주의 필요한 신호 1줄 요약 (조건부 표시)
//      - 비대칭 KPI: 리스크율(크게, 좌) + 총CS건수(보조, 중) + Wings미해결(보조, 우)
//   2. 운영 이슈 영역 (좌: Wings / 우: 학부모)
//      - 각 카드: 상태 배지 + 항목별 건수 + 비율 progress bar
//   3. 보고서 진입 카드 2개
//
// 데이터 흐름:
//   fetchDaily × 2                → 이번 주 / 전주 일별 건수 (전주 대비)
//   fetchCategory × 2             → 이번 주 / 전주 리스크율
//   fetchWingsTickets             → 미해결 / 처리지연 / 이번주 신규
//   fetchRepeatParents            → 반복인입 / 동일이슈반복 / 복합이슈 / 단기재인입
//
// 의존: api/client.ts, api/categories.ts (isAllowed)
import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type InsightWings, type InsightParent } from '../../api/client'
import { isAllowed } from '../../api/categories'

// ── 날짜 유틸 ────────────────────────────────────────────────────────────────

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function daysAgoStr(n: number) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function diffDaysFromToday(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
}

// ── Wings 판별 ────────────────────────────────────────────────────────────────

function isUnresolved(r: InsightWings): boolean {
  return r.state !== '해결' && r.state !== '요청취소' && r.state !== 'merged'
}

function isDelayed(r: InsightWings): boolean {
  return !!r.first_date && diffDaysFromToday(r.first_date) >= 7 && isUnresolved(r)
}

// ── 학부모 판별 ──────────────────────────────────────────────────────────────

function qualifyingMemoCount(r: InsightParent): number {
  return r.memos.filter(m => {
    const [main, sub] = m.category.split(' > ')
    return isAllowed(main, sub ?? null)
  }).length
}

function isQualified(r: InsightParent): boolean {
  return qualifyingMemoCount(r) >= 3
}

function parentHasSameIssue(r: InsightParent): boolean {
  const counts: Record<string, number> = {}
  r.memos.forEach(m => {
    const [main, sub] = m.category.split(' > ')
    if (!isAllowed(main, sub ?? null)) return
    counts[main] = (counts[main] ?? 0) + 1
  })
  return Object.values(counts).some(c => c >= 2)
}

function parentIsComplex(r: InsightParent): boolean {
  const mains = new Set(
    r.memos
      .filter(m => { const [main, sub] = m.category.split(' > '); return isAllowed(main, sub ?? null) })
      .map(m => m.category.split(' > ')[0])
  )
  return mains.size >= 3
}

function parentHasShortGap(r: InsightParent): boolean {
  const dates = r.memos
    .filter(m => { const [main, sub] = m.category.split(' > '); return isAllowed(main, sub ?? null) })
    .map(m => new Date(m.date).getTime())
    .sort((a, b) => a - b)
  for (let i = 1; i < dates.length; i++) {
    if ((dates[i] - dates[i - 1]) / 86400000 <= 2) return true
  }
  return false
}

// ── 리스크율 계산 ────────────────────────────────────────────────────────────

function calcRiskRate(cats: { new_category_main: string; new_category_sub: string; count: number }[]): number {
  const risk  = cats.filter(c => isAllowed(c.new_category_main, c.new_category_sub)).reduce((s, c) => s + c.count, 0)
  const total = cats.reduce((s, c) => s + c.count, 0)
  return total > 0 ? Math.round(risk / total * 100) : 0
}

// ── 서브 컴포넌트 ────────────────────────────────────────────────────────────

function DeltaBadge({ delta, colorCode = true, large = false }: { delta: number | null; colorCode?: boolean; large?: boolean }) {
  if (delta === null) return null
  const symbol = delta > 0 ? '↑' : delta < 0 ? '↓' : '—'
  let color = 'rgba(255,255,255,0.4)'
  let bg    = 'transparent'
  let border = 'transparent'
  if (colorCode && delta !== 0) {
    color  = delta > 0 ? '#f87171' : '#34d399'
    bg     = delta > 0 ? 'rgba(239,68,68,0.15)' : 'rgba(52,211,153,0.12)'
    border = delta > 0 ? 'rgba(239,68,68,0.3)'  : 'rgba(52,211,153,0.3)'
  }
  return (
    <span style={{
      fontSize: large ? 13 : 11,
      fontWeight: 600,
      color,
      background: large ? bg : undefined,
      border: large ? `1px solid ${border}` : undefined,
      padding: large ? '4px 10px' : undefined,
      borderRadius: large ? 6 : undefined,
    }}>
      {symbol} {Math.abs(delta)}% 전주 대비
    </span>
  )
}

function ProgressBar({ value, total, color }: { value: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round(value / total * 100) : 0
  return (
    <div style={{ height: 4, background: '#f1f5f9', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2, transition: 'width 0.4s ease' }} />
    </div>
  )
}

function DetailButton({ to }: { to: string }) {
  return (
    <Link
      to={to}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '7px 14px',
        background: '#fff', border: '1px solid #d1d5db',
        borderRadius: 8, textDecoration: 'none',
        color: '#374151', fontSize: 13, fontWeight: 500,
      }}
    >
      상세 보기 <span style={{ fontSize: 14, lineHeight: 1, color: '#9ca3af' }}>›</span>
    </Link>
  )
}

const CARD: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 14,
  boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
  overflow: 'hidden',
}

// ── 메인 컴포넌트 ────────────────────────────────────────────────────────────

export default function StrategicDashboard() {
  const [weekTotal,     setWeekTotal]     = useState<number | null>(null)
  const [prevWeekTotal, setPrevWeekTotal] = useState<number | null>(null)
  const [riskRate,      setRiskRate]      = useState<number | null>(null)
  const [prevRiskRate,  setPrevRiskRate]  = useState<number | null>(null)
  const [wings,   setWings]   = useState<InsightWings[]>([])
  const [parents, setParents] = useState<InsightParent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const today    = todayStr()
    const prevWeek = daysAgoStr(7)
    Promise.all([
      api.fetchDaily(today, 'week'),
      api.fetchDaily(prevWeek, 'week'),
      api.fetchCategory({ targetDate: today,    period: 'week' }),
      api.fetchCategory({ targetDate: prevWeek, period: 'week' }),
      api.fetchWingsTickets(),
      api.fetchRepeatParents(),
    ]).then(([daily, prevDaily, cats, prevCats, w, p]) => {
      setWeekTotal(daily.reduce((s, r) => s + r.count, 0))
      setPrevWeekTotal(prevDaily.reduce((s, r) => s + r.count, 0))
      setRiskRate(calcRiskRate(cats))
      setPrevRiskRate(calcRiskRate(prevCats))
      setWings(w.data || [])
      setParents((p.data || []).filter(isQualified))
    }).finally(() => setLoading(false))
  }, [])

  // ── 파생값 ──────────────────────────────────────────────────────────────────

  const unresolvedWings  = wings.filter(isUnresolved)
  const delayedWings     = wings.filter(isDelayed)
  const newWingsThisWeek = wings.filter(r => r.first_date && diffDaysFromToday(r.first_date) <= 7).length
  const totalWingsCs     = wings.reduce((s, r) => s + r.cs_count, 0)

  const parentSameIssue = parents.filter(parentHasSameIssue).length
  const parentComplex   = parents.filter(parentIsComplex).length
  const parentShortGap  = parents.filter(parentHasShortGap).length
  const maxParentCs     = parents.length > 0 ? Math.max(...parents.map(qualifyingMemoCount)) : 0

  const today     = todayStr()
  const weekStart = daysAgoStr(6)

  function getDelta(cur: number | null, prev: number | null) {
    if (cur == null || prev == null || prev === 0) return null
    return Math.round((cur - prev) / prev * 100)
  }
  const csDelta   = getDelta(weekTotal, prevWeekTotal)
  const riskDelta = getDelta(riskRate, prevRiskRate)

  // 리스크 알림 배너 항목
  const riskAlerts: string[] = []
  if (!loading) {
    if (riskDelta !== null && riskDelta > 0) riskAlerts.push(`리스크율 ↑ +${riskDelta}%`)
    if (delayedWings.length > 0)             riskAlerts.push(`처리 지연 ${delayedWings.length}건`)
    if (parentSameIssue > 0)                 riskAlerts.push(`동일 이슈 반복 ${parentSameIssue}명`)
  }

  // ── 렌더 ────────────────────────────────────────────────────────────────────

  return (
    <div className="container">

      {/* ── Section 1: 네이비 브리핑 영역 ── */}
      <div style={{ background: '#1a2744', borderRadius: 16, padding: '28px 32px', marginBottom: 20 }}>

        {/* 헤더 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: riskAlerts.length > 0 ? 16 : 24 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.35)', letterSpacing: '1.2px', marginBottom: 6 }}>
              WEEKLY CS BRIEFING
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#fff', lineHeight: 1.2 }}>
              주간 CS 운영 브리핑
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', marginBottom: 4 }}>
              {weekStart} ~ {today}
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
              {loading ? '조회 중...' : `업데이트 ${today}`}
            </div>
          </div>
        </div>

        {/* 리스크 알림 배너 */}
        {!loading && riskAlerts.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'rgba(239,68,68,0.12)',
            border: '1px solid rgba(239,68,68,0.25)',
            borderRadius: 8, padding: '10px 16px', marginBottom: 20,
          }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#f87171', whiteSpace: 'nowrap' }}>
              ⚠ 주의 필요
            </span>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', lineHeight: 1.4 }}>
              {riskAlerts.join('  ·  ')}
            </span>
          </div>
        )}

        {/* 비대칭 KPI */}
        {loading ? (
          <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: 13, padding: '12px 0' }}>조회 중...</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 1.5fr', gap: 14 }}>

            {/* 리스크율 — 크게 */}
            <div style={{
              background: 'rgba(255,255,255,0.07)',
              border: `1px solid ${(riskRate ?? 0) >= 20 ? 'rgba(239,68,68,0.35)' : 'rgba(255,255,255,0.1)'}`,
              borderLeft: `4px solid ${(riskRate ?? 0) >= 20 ? '#f87171' : '#fbbf24'}`,
              borderRadius: 12, padding: '22px 26px',
            }}>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', fontWeight: 600, letterSpacing: '0.4px', marginBottom: 14 }}>
                리스크율
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, marginBottom: 10 }}>
                <span style={{ fontSize: 52, fontWeight: 800, color: (riskRate ?? 0) >= 20 ? '#f87171' : '#fff', lineHeight: 1 }}>
                  {riskRate != null ? `${riskRate}%` : '—'}
                </span>
                <DeltaBadge delta={riskDelta} colorCode large />
              </div>
            </div>

            {/* 총 CS 건수 — 보조 */}
            <div style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderLeft: '4px solid #60a5fa',
              borderRadius: 12, padding: '22px 24px',
            }}>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', fontWeight: 600, letterSpacing: '0.4px', marginBottom: 14 }}>
                총 CS 건수
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginBottom: 6 }}>
                <span style={{ fontSize: 38, fontWeight: 800, color: '#fff', lineHeight: 1 }}>{weekTotal ?? '—'}</span>
                <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)' }}>건</span>
              </div>
              <DeltaBadge delta={csDelta} colorCode={false} />
            </div>

            {/* Wings 미해결 — 보조 */}
            <div style={{
              background: 'rgba(255,255,255,0.05)',
              border: `1px solid ${delayedWings.length > 0 ? 'rgba(239,68,68,0.25)' : 'rgba(255,255,255,0.08)'}`,
              borderLeft: `4px solid ${delayedWings.length > 0 ? '#f87171' : '#60a5fa'}`,
              borderRadius: 12, padding: '22px 24px',
            }}>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', fontWeight: 600, letterSpacing: '0.4px', marginBottom: 14 }}>
                Wings 미해결
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginBottom: 14 }}>
                <span style={{ fontSize: 38, fontWeight: 800, color: '#fff', lineHeight: 1 }}>{unresolvedWings.length}</span>
                <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)' }}>건</span>
              </div>
              {/* 처리지연 비율 바 */}
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>처리 지연</span>
                  <span style={{ fontSize: 11, color: delayedWings.length > 0 ? '#f87171' : 'rgba(255,255,255,0.4)', fontWeight: 600 }}>
                    {delayedWings.length}건
                  </span>
                </div>
                <div style={{ height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2 }}>
                  <div style={{
                    height: '100%',
                    width: unresolvedWings.length > 0 ? `${Math.round(delayedWings.length / unresolvedWings.length * 100)}%` : '0%',
                    background: '#f87171', borderRadius: 2,
                  }} />
                </div>
              </div>
            </div>

          </div>
        )}
      </div>

      {/* ── Section 2: 운영 이슈 영역 ── */}
      {!loading && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>

          {/* Wings 카드 */}
          <div style={{ ...CARD, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '22px 24px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 3 }}>반복 Wings 티켓</div>
                  <div style={{ fontSize: 12, color: '#94a3b8' }}>여러 CS에서 반복 언급된 미해결 티켓</div>
                </div>
                {delayedWings.length > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#ef4444', background: '#fee2e2', padding: '4px 10px', borderRadius: 6, whiteSpace: 'nowrap' }}>
                    처리 지연 있음
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
                {[
                  { label: '미해결',           value: unresolvedWings.length, total: wings.length,          color: '#3b82f6' },
                  { label: '처리 지연 (7일+)', value: delayedWings.length,    total: unresolvedWings.length, color: '#ef4444' },
                  { label: '이번 주 신규',     value: newWingsThisWeek,        total: wings.length,          color: '#f59e0b' },
                ].map(item => (
                  <div key={item.label}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                      <span style={{ fontSize: 13, color: '#64748b' }}>{item.label}</span>
                      <span style={{ fontSize: 16, fontWeight: 700, color: item.color }}>{item.value}건</span>
                    </div>
                    <ProgressBar value={item.value} total={item.total} color={item.color} />
                  </div>
                ))}
              </div>
            </div>

            <div style={{ padding: '14px 24px 18px', borderTop: '1px solid #f1f5f9', marginTop: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>총 CS 언급 {totalWingsCs}건</span>
              <DetailButton to="/insights/wings" />
            </div>
          </div>

          {/* 학부모 카드 */}
          <div style={{ ...CARD, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '22px 24px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 3 }}>학부모 반복 인입</div>
                  <div style={{ fontSize: 12, color: '#94a3b8' }}>최근 30일 내 3회 이상 CS 인입</div>
                </div>
                {parentSameIssue > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#d97706', background: '#fef3c7', padding: '4px 10px', borderRadius: 6, whiteSpace: 'nowrap' }}>
                    미해결 의심
                  </span>
                )}
              </div>

              {/* 헤드라인 수 */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginBottom: 18 }}>
                <span style={{ fontSize: 32, fontWeight: 800, color: '#111827', lineHeight: 1 }}>{parents.length}</span>
                <span style={{ fontSize: 13, color: '#94a3b8' }}>명</span>
                <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 4 }}>반복 인입 학부모</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
                {[
                  { label: '동일 이슈 반복', value: parentSameIssue, total: parents.length, color: '#f59e0b', note: '미해결 가능성' },
                  { label: '복합 이슈',       value: parentComplex,   total: parents.length, color: '#ef4444', note: '유형 3개 이상' },
                  { label: '단기간 재인입',   value: parentShortGap,  total: parents.length, color: '#8b5cf6', note: '2일 내 재인입' },
                ].map(item => (
                  <div key={item.label}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ fontSize: 13, color: '#64748b' }}>{item.label}</span>
                        <span style={{ fontSize: 10, color: '#94a3b8' }}>{item.note}</span>
                      </div>
                      <span style={{ fontSize: 16, fontWeight: 700, color: item.color }}>{item.value}명</span>
                    </div>
                    <ProgressBar value={item.value} total={item.total} color={item.color} />
                  </div>
                ))}
              </div>
            </div>

            <div style={{ padding: '14px 24px 18px', borderTop: '1px solid #f1f5f9', marginTop: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>최다 인입 {maxParentCs}건</span>
              <DetailButton to="/insights/parents" />
            </div>
          </div>

        </div>
      )}

      {/* ── Section 3: 보고서 진입 ── */}
      {!loading && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {[
            { label: '주간 보고서', desc: '주간 CS 트렌드 및 AI 분석', to: '/report/weekly' },
            { label: '일별 보고서', desc: '일별 카테고리 분석 및 피크타임', to: '/report/daily' },
          ].map(r => (
            <Link
              key={r.to}
              to={r.to}
              style={{
                ...CARD,
                padding: '18px 24px',
                textDecoration: 'none',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 4 }}>{r.label}</div>
                <div style={{ fontSize: 12, color: '#94a3b8' }}>{r.desc}</div>
              </div>
              <span style={{ fontSize: 20, color: '#d1d5db' }}>›</span>
            </Link>
          ))}
        </div>
      )}

    </div>
  )
}
