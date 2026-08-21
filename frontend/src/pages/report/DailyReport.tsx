// 일별 CS 보고서 페이지.
// 날짜를 선택하면 저장된 보고서를 불러오고, 없으면 생성 버튼으로 Gemma 기반 보고서를 생성한다.
//
// 리디자인 구성 (Pretendard 폰트, 네이비 브랜드 컬러 #1e3c72):
//   1. 그라디언트 헤더 배너 — 날짜 표시
//   2. KPI 카드 3개 — 총 상담 / 리스크 이슈 / 리스크 비율
//   3. 리스크 카테고리 현황 — 수평 바 차트 (대분류별 top 소분류 건수)
//   4. 카테고리별 AI 분석 — 소분류 + AI 2줄 요약 + 메모 드롭다운(20개씩 페이징)
//   5. 피크타임 특이사항 (17~20시) — 최다 버킷 AI 분석
//
// 데이터 흐름:
//   GET  /api/report/daily?date=YYYY-MM-DD  → 저장된 보고서 반환 (없으면 404)
//   POST /api/report/daily/generate?date=YYYY-MM-DD → 보고서 생성 (Gemma 호출)
//
// 의존: api/client.ts (DailyReport, RiskRow, PeakBucket 타입, fetchDailyReport, generateDailyReport)
import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import Chart from 'chart.js/auto'
import { api, type DailyReport, type RiskRow, type BucketRow, type Issue } from '../../api/client'
import CategoryMemoModal from '../../components/CategoryMemoModal'

const NAVY = '#1e3c72'
const NAVY2 = '#2a5298'
const RISK_RED = '#ef4444'

const RISK_MAINS = ['네트워크·앱 오류', '기기·하드웨어 오류', '교재·물류·배송']

// ── 카테고리 AI 분석 패널 ──────────────────────────────────────────────────────

const TEST_TARGETS = ['피크타임 패턴 분석', ...RISK_MAINS]

type CategoryResult = { main?: string; sub: string; count: number; summary: string; insufficient_data: boolean; gemma_error?: string | null; prompt_section: string }
type PeakResult = { bucket_start: string; bucket_end: string; bucket_count: number; avg_count: number; pattern: string; summary: string; has_pattern: boolean; insufficient_data: boolean; gemma_error?: string | null; prompt_section: string }

function CategoryTestPanel({
  date,
  onCategoryResult,
  onPeakResult,
}: {
  date: string
  onCategoryResult: (main: string, summary: string, gemmaError?: string | null) => void
  onPeakResult: (peak: PeakResult) => void
}) {
  const [target, setTarget] = useState(TEST_TARGETS[0])
  const [running, setRunning] = useState(false)
  const [catResult, setCatResult] = useState<CategoryResult | null>(null)
  const [peakResult, setPeakResult] = useState<PeakResult | null>(null)
  const [error, setError] = useState('')

  function resetResults() {
    setCatResult(null)
    setPeakResult(null)
    setError('')
  }

  async function handleRun() {
    setRunning(true)
    resetResults()
    try {
      if (target === '피크타임 패턴 분석') {
        const data = await api.analyzeDailyPeak(date)
        setPeakResult(data)
        onPeakResult(data)
      } else {
        const data = await api.analyzeDailyCategory(date, target)
        setCatResult(data)
        onCategoryResult(target, data.summary, data.gemma_error)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div style={{ marginTop: 16, padding: '16px 20px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#166534', marginBottom: 12 }}>AI 분석 실행</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <select
          value={target}
          onChange={e => { setTarget(e.target.value); resetResults() }}
          style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, flex: 1 }}
        >
          {TEST_TARGETS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <button
          onClick={handleRun}
          disabled={running}
          style={{
            padding: '6px 16px', background: running ? '#94a3b8' : '#166534',
            color: '#fff', border: 'none', borderRadius: 6,
            fontSize: 13, fontWeight: 600, cursor: running ? 'default' : 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {running ? '분석 중...' : '분석 실행'}
        </button>
      </div>

      {error && <div style={{ fontSize: 12, color: RISK_RED }}>{error}</div>}

      {catResult && (
        <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.6 }}>
          <div style={{ marginBottom: 6 }}>
            <span style={{ fontWeight: 700 }}>{catResult.sub}</span>
            <span style={{ color: '#64748b', marginLeft: 6 }}>{catResult.count}건</span>
            {catResult.insufficient_data && <span style={{ color: '#f59e0b', marginLeft: 8 }}>데이터 부족</span>}
            {catResult.gemma_error && <span style={{ color: RISK_RED, marginLeft: 8 }} title={catResult.gemma_error}>AI 분석 실패</span>}
          </div>
          {catResult.prompt_section && (
            <details style={{ marginBottom: 8 }}>
              <summary style={{ cursor: 'pointer', color: '#64748b', marginBottom: 4 }}>프롬프트 보기</summary>
              <pre style={{ fontSize: 11, background: '#f8fafc', padding: '8px 10px', borderRadius: 6, overflowX: 'auto', whiteSpace: 'pre-wrap', border: '1px solid #e2e8f0' }}>
                {catResult.prompt_section}
              </pre>
            </details>
          )}
          {catResult.summary && (
            <div style={{ background: '#f0f4fb', borderRadius: 6, padding: '7px 12px', borderLeft: `3px solid ${NAVY}`, fontSize: 13 }}>
              {catResult.summary}
            </div>
          )}
        </div>
      )}

      {peakResult && (
        <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.6 }}>
          <div style={{ marginBottom: 6 }}>
            <span style={{ fontWeight: 700 }}>{peakResult.bucket_start}~{peakResult.bucket_end}</span>
            <span style={{ color: '#64748b', marginLeft: 6 }}>{peakResult.bucket_count}건 (평균 {peakResult.avg_count}건)</span>
            {peakResult.insufficient_data && <span style={{ color: '#f59e0b', marginLeft: 8 }}>데이터 부족</span>}
            {peakResult.gemma_error && <span style={{ color: RISK_RED, marginLeft: 8 }} title={peakResult.gemma_error}>AI 분석 실패</span>}
            {!peakResult.insufficient_data && !peakResult.gemma_error && (
              <span style={{ marginLeft: 8, color: peakResult.has_pattern ? '#166534' : '#64748b' }}>
                {peakResult.has_pattern ? '패턴 있음' : '패턴 없음'}
              </span>
            )}
          </div>
          {peakResult.prompt_section && (
            <details style={{ marginBottom: 8 }}>
              <summary style={{ cursor: 'pointer', color: '#64748b', marginBottom: 4 }}>프롬프트 보기</summary>
              <pre style={{ fontSize: 11, background: '#f8fafc', padding: '8px 10px', borderRadius: 6, overflowX: 'auto', whiteSpace: 'pre-wrap', border: '1px solid #e2e8f0' }}>
                {peakResult.prompt_section}
              </pre>
            </details>
          )}
          {peakResult.summary && (
            <div style={{ background: '#f0f4fb', borderRadius: 6, padding: '7px 12px', borderLeft: `3px solid ${NAVY}`, fontSize: 13 }}>
              {peakResult.summary}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── 툴팁 ─────────────────────────────────────────────────────────────────────


// ── KPI 카드 ──────────────────────────────────────────────────────────────────

function DeltaBadge({ delta, unit, invert, neutral }: { delta: number | null | undefined; unit: string; invert?: boolean; neutral?: boolean }) {
  if (delta == null) return null
  if (delta === 0) return <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 5 }}>전일 동일</div>
  const isPositive = delta > 0
  const color = neutral
    ? '#64748b'
    : invert
      ? (isPositive ? '#ef4444' : '#16a34a')
      : (isPositive ? '#3b82f6' : '#f59e0b')
  const arrow = isPositive ? '↑' : '↓'
  return (
    <div style={{ fontSize: 13, color, fontWeight: 600, marginTop: 5 }}>
      {arrow} {isPositive ? '+' : ''}{delta}{unit}
      <span style={{ color: '#94a3b8', fontWeight: 400, marginLeft: 4 }}>전일 대비</span>
    </div>
  )
}

function KpiCard({
  label, value, unit, color, delta, deltaUnit, deltaInvert, deltaNeutral, isSecondary,
}: {
  label: string; value: string; unit: string; color: string
  delta?: number | null; deltaUnit?: string; deltaInvert?: boolean; deltaNeutral?: boolean; isSecondary?: boolean
}) {
  return (
    <div style={{
      background: '#fff', borderRadius: 14,
      padding: isSecondary ? '16px 20px' : '22px 26px',
      boxShadow: isSecondary ? '0 1px 4px rgba(0,0,0,.06)' : '0 2px 10px rgba(0,0,0,.09)',
      borderTop: `${isSecondary ? 3 : 5}px solid ${color}`,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: '#94a3b8',
        textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 8,
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: isSecondary ? 36 : 48, fontWeight: 800, color, lineHeight: 1 }}>{value}</span>
        <span style={{ fontSize: isSecondary ? 17 : 22, color: '#64748b', fontWeight: 600 }}>{unit}</span>
      </div>
      <DeltaBadge delta={delta} unit={deltaUnit ?? ''} invert={deltaInvert} neutral={deltaNeutral} />
    </div>
  )
}

// ── 리스크 바 차트 ────────────────────────────────────────────────────────────


function RiskBarChart({ rows, onBarClick }: {
  rows: RiskRow[]
  onBarClick: (main: string, sub: string | null) => void
}) {
  const sorted = [...rows].sort((a, b) => (b.main_total ?? b.count) - (a.main_total ?? a.count))
  const allSubCounts = sorted.flatMap(r => (r.subs?.length ? r.subs.map(s => s.count) : [r.count]))
  const max = Math.max(...allSubCounts, 1)
  const topRow = sorted[0]

  return (
    <div>
      {topRow && (
        <div style={{
          background: '#fef2f2', borderRadius: 10,
          padding: '10px 14px', marginBottom: 16,
          borderLeft: '4px solid #ef4444',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#1e293b' }}>오늘의 주요 리스크</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: '#ef4444' }}>{topRow.main} › {topRow.sub}</span>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#ef4444' }}>({topRow.count.toLocaleString()}건)</span>
        </div>
      )}
      {sorted.map((row, i) => {
        const subs = row.subs?.length ? row.subs : [{ sub: row.sub, count: row.count, memos: row.memos }]
        return (
          <div key={i} style={{ marginBottom: i < sorted.length - 1 ? 22 : 0 }}>
            <div
              onClick={() => onBarClick(row.main, null)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, cursor: 'pointer' }}
            >
              <span style={{ fontWeight: 700, fontSize: 15, color: '#1e293b' }}>{row.main}</span>
              <span style={{ fontSize: 14, color: '#94a3b8' }}>총 {(row.main_total ?? row.count).toLocaleString()}건</span>
            </div>
            {subs.map((s, si) => {
              const isTop = si === 0
              return (
                <div
                  key={si}
                  onClick={() => onBarClick(row.main, s.sub)}
                  style={{ paddingLeft: 12, marginBottom: si < subs.length - 1 ? 10 : 0, cursor: 'pointer' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 16, fontWeight: isTop ? 700 : 400, color: isTop ? '#ef4444' : '#374151' }}>
                      {s.sub}
                    </span>
                    <span style={{ fontSize: 17, fontWeight: isTop ? 700 : 500, color: isTop ? '#ef4444' : '#64748b', flexShrink: 0, marginLeft: 8 }}>
                      {s.count.toLocaleString()}건
                    </span>
                  </div>
                  <div style={{ background: '#e8eef6', borderRadius: 4, height: 7 }}>
                    <div style={{ width: `${(s.count / max) * 100}%`, background: isTop ? '#ef4444' : '#94a3b8', height: '100%', borderRadius: 4, minWidth: s.count > 0 ? 3 : 0 }} />
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// ── 리스크 행 ─────────────────────────────────────────────────────────────────

function RiskRowItem({ row, aiLoading = false }: { row: RiskRow; aiLoading?: boolean }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0', marginBottom: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>{row.main}</span>
        <span style={{ fontSize: 12, color: '#cbd5e1' }}>›</span>
        <span style={{ fontWeight: 700, fontSize: 15, color: '#1e293b' }}>{row.sub}</span>
        <span style={{ fontSize: 15, fontWeight: 700, color: RISK_RED, background: '#fef2f2', borderRadius: 6, padding: '2px 8px', border: '1px solid #fecaca', flexShrink: 0 }}>
          {row.count}건
        </span>
      </div>
      <div style={{ padding: '10px 16px' }}>
        {row.summary ? (
          <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.7, borderLeft: `3px solid ${NAVY}`, paddingLeft: 10 }}>
            {row.summary}
          </div>
        ) : row.gemma_error ? (
          <div style={{ fontSize: 12, color: RISK_RED }} title={row.gemma_error}>
            AI 분석 실패 — 다시 시도해주세요
          </div>
        ) : aiLoading ? (
          <div style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }}>AI 분석 중...</div>
        ) : (
          <div style={{ fontSize: 12, color: '#94a3b8' }}>AI 분석 없음</div>
        )}
      </div>
    </div>
  )
}

// ── 시간대별 전체 흐름 차트 ──────────────────────────────────────────────────

function HourlyBucketChart({ buckets, onBarClick }: {
  buckets: BucketRow[]
  onBarClick?: (bucket: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const onBarClickRef = useRef(onBarClick)
  onBarClickRef.current = onBarClick

  useEffect(() => {
    if (!canvasRef.current || buckets.length === 0) return
    chartRef.current?.destroy()

    const data = buckets.map(b => b.count)
    const maxVal = Math.max(...data, 1)
    const bgColors = buckets.map((b, i) => {
      if (data[i] === maxVal && data[i] > 0) return '#ef4444'
      if (b.bucket >= '17:00' && b.bucket <= '20:30') return '#3b82f6'
      return '#e2e8f0'
    })

    chartRef.current = new Chart(canvasRef.current, {
      type: 'bar',
      data: {
        labels: buckets.map(b => b.bucket),
        datasets: [{ data, backgroundColor: bgColors, borderRadius: 3, borderSkipped: false, barPercentage: 0.8 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (_e: unknown, elements: any[]) => {
          if (elements.length > 0) onBarClickRef.current?.(buckets[elements[0].index].bucket)
        },
        onHover: (ev: any, elements: any[]) => {
          const t = ev.native?.target as HTMLElement | undefined
          if (t) t.style.cursor = elements.length ? 'pointer' : 'default'
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx: any) => `${(ctx.raw as number).toLocaleString()}건` } },
        },
        scales: {
          y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 } } },
          x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0 } },
        },
      },
    })
    return () => { chartRef.current?.destroy() }
  }, [buckets])

  return <canvas ref={canvasRef} />
}

// ── 피크타임 30분 버킷 차트 ───────────────────────────────────────────────────


// ── 피크타임 버킷 메모 모달 ───────────────────────────────────────────────────

const PEAK_PAGE_SIZE = 50

function bucketsToKstRange(buckets: string[]): string {
  // 버킷 포맷: "HH:MM" KST
  const first = buckets[0]
  const last = buckets[buckets.length - 1]
  const [endH, endM] = last.split(':').map(Number)
  const endMin = endM === 0 ? 30 : 0
  const endHour = endM === 0 ? endH : endH + 1
  return `${first}~${String(endHour).padStart(2, '0')}:${String(endMin).padStart(2, '0')}`
}

function PeakMemoModal({ buckets, date, onClose }: { buckets: string[]; date: string; onClose: () => void }) {
  const [availableMains, setAvailableMains] = useState<string[]>([])
  const [checkedMains, setCheckedMains] = useState<string[]>([])
  const [allMemos, setAllMemos] = useState<Issue[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  useEffect(() => {
    Promise.all([
      api.fetchCategory({ startDate: date, endDate: date, buckets }),
      api.fetchIssues({ startDate: date, endDate: date, buckets, limit: 500 }),
    ]).then(([cats, issues]) => {
      const mains = [...new Set(cats.map(c => c.new_category_main).filter(Boolean))] as string[]
      setAvailableMains(mains)
      setCheckedMains(mains)
      setAllMemos(issues.items)
    }).catch(() => {}).finally(() => setLoading(false))
  }, [buckets, date])

  function toggleMain(main: string) {
    setCheckedMains(prev => prev.includes(main) ? prev.filter(m => m !== main) : [...prev, main])
    setPage(1)
  }

  function toggleAll() {
    setCheckedMains(prev => prev.length === availableMains.length ? [] : [...availableMains])
    setPage(1)
  }

  const filtered = allMemos.filter(m => checkedMains.includes(m.new_category_main ?? ''))
  const total = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / PEAK_PAGE_SIZE))
  const pageMemos = filtered.slice((page - 1) * PEAK_PAGE_SIZE, page * PEAK_PAGE_SIZE)
  const allChecked = checkedMains.length === availableMains.length

  const pager = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#64748b' }}>
      <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: '4px 14px', background: '#fff', fontSize: 13, cursor: page <= 1 ? 'default' : 'pointer', color: page <= 1 ? '#cbd5e1' : '#374151' }}>이전</button>
      <span>{page} / {totalPages} 페이지 (총 {total.toLocaleString()}건)</span>
      <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: '4px 14px', background: '#fff', fontSize: 13, cursor: page >= totalPages ? 'default' : 'pointer', color: page >= totalPages ? '#cbd5e1' : '#374151' }}>다음</button>
    </div>
  )

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 960, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.2)', overflow: 'hidden' }}>

        {/* 헤더 */}
        <div style={{ padding: '18px 32px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#1e293b' }}>피크타임 메모 — {bucketsToKstRange(buckets)}</div>
            <div style={{ marginTop: 4, fontSize: 15, color: '#475569', fontWeight: 500 }}>{date}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#94a3b8', lineHeight: 1, padding: 4 }}>✕</button>
        </div>

        {/* 대분류 체크박스 */}
        {availableMains.length > 0 && (
          <div style={{ padding: '10px 32px', borderBottom: '1px solid #f1f5f9', display: 'flex', flexWrap: 'wrap', gap: '6px 20px', alignItems: 'center', flexShrink: 0, background: '#fafafa' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={allChecked} onChange={toggleAll} style={{ cursor: 'pointer', accentColor: '#1e3c72' }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>전체</span>
            </label>
            {availableMains.map(main => (
              <label key={main} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input type="checkbox" checked={checkedMains.includes(main)} onChange={() => toggleMain(main)} style={{ cursor: 'pointer', accentColor: '#1e3c72' }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: checkedMains.includes(main) ? '#1e293b' : '#cbd5e1', transition: 'color 0.15s' }}>{main}</span>
              </label>
            ))}
          </div>
        )}

        {/* 상단 페이지네이션 */}
        <div style={{ padding: '10px 32px', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>{pager}</div>

        {/* 테이블 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px' }}>
          {loading ? (
            <div style={{ padding: '60px 0', textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>조회 중...</div>
          ) : pageMemos.length === 0 ? (
            <div style={{ padding: '60px 0', textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>메모 없음</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                  {['대분류', '소분류', '학생번호', '학부모번호', '내용', '등록일'].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 12, fontWeight: 700, color: '#64748b', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageMemos.map(m => (
                  <tr key={m.id} style={{ borderBottom: '1px solid #f8fafc' }}>
                    <td style={{ padding: '9px 12px', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#374151', background: '#f1f5f9', borderRadius: 4, padding: '2px 7px' }}>{m.new_category_main ?? '—'}</span>
                    </td>
                    <td style={{ padding: '9px 12px', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                      {m.new_category_sub ? <span style={{ fontSize: 12, fontWeight: 700, color: '#374151', background: '#f1f5f9', borderRadius: 4, padding: '2px 7px' }}>{m.new_category_sub}</span> : <span style={{ color: '#cbd5e1', fontSize: 12 }}>—</span>}
                    </td>
                    <td style={{ padding: '9px 12px', fontSize: 12, color: '#64748b', verticalAlign: 'top', whiteSpace: 'nowrap' }}>{m.student_id || '—'}</td>
                    <td style={{ padding: '9px 12px', fontSize: 12, color: '#64748b', verticalAlign: 'top', whiteSpace: 'nowrap' }}>{m.parent_id ?? '—'}</td>
                    <td style={{ padding: '9px 12px', fontSize: 13, color: '#374151', lineHeight: 1.6, verticalAlign: 'top' }}>
                      {m.call_memo ? m.call_memo.split('\n').map((line: string, i: number) => <span key={i}>{i > 0 && <br />}{line}</span>) : <span style={{ color: '#cbd5e1' }}>—</span>}
                    </td>
                    <td style={{ padding: '9px 12px', fontSize: 12, color: '#94a3b8', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                      {m.created_date ? m.created_date.slice(0, 16).replace('T', ' ') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 하단 페이지네이션 */}
        <div style={{ padding: '12px 32px', borderTop: '1px solid #f1f5f9', flexShrink: 0 }}>{pager}</div>
      </div>
    </div>
  )
}

// ── 유틸 ──────────────────────────────────────────────────────────────────────

function yesterday() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
}

async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  const result = await Notification.requestPermission()
  return result === 'granted'
}

function showReportNotification(data: DailyReport, targetUrl: string) {
  const n = new Notification('보고서 생성 완료', {
    body: `${data.report_date} · 총 ${data.total_count}건 · 리스크 ${data.risk_total}건`,
  })
  n.onclick = () => {
    window.focus()
    window.location.href = targetUrl
  }
}

// ── 메인 페이지 ───────────────────────────────────────────────────────────────

export default function DailyReport() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [date, setDate] = useState(() => searchParams.get('date') ?? yesterday())
  const [report, setReport] = useState<DailyReport | null>(null)
  const [peakBuckets, setPeakBuckets] = useState<BucketRow[]>([])
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [aiGenerating, setAiGenerating] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [modalState, setModalState] = useState<{ main: string; initialSubs?: string[]; allowedSubs?: string[] } | null>(null)
  const [peakModalBuckets, setPeakModalBuckets] = useState<string[] | null>(null)

  useEffect(() => {
    setSearchParams({ date }, { replace: true })
    loadReport(date)
  }, [date])

  async function loadReport(d: string) {
    setLoading(true)
    setReport(null)
    setPeakBuckets([])
    setNotFound(false)
    try {
      const [data, buckets] = await Promise.all([
        api.fetchDailyReport(d),
        api.fetchHourly(d, d),
      ])
      setReport(data)
      setPeakBuckets(buckets)
    } catch {
      setNotFound(true)
    } finally {
      setLoading(false)
    }
  }

  async function handleGenerate() {
    setGenerating(true)
    try {
      // 1단계: 통계만 생성 → 차트 바로 렌더링
      const [statsData, buckets] = await Promise.all([
        api.generateDailyReportStats(date),
        api.fetchHourly(date, date),
      ])
      setReport(statsData)
      setPeakBuckets(buckets)
      setNotFound(false)
      setGenerating(false)

      // 2단계: AI 분석 — 카테고리별 순차 호출, 완료되는 즉시 반영
      setAiGenerating(true)
      const failedNames: string[] = []
      for (const row of statsData.risk_rows) {
        try {
          const result = await api.analyzeDailyCategory(date, row.main)
          if (result.gemma_error) failedNames.push(row.main)
          setReport(prev => prev ? {
            ...prev,
            risk_rows: prev.risk_rows.map(r =>
              r.main === row.main
                ? { ...r, summary: result.summary, insufficient_data: result.insufficient_data, gemma_error: result.gemma_error }
                : r
            ),
          } : prev)
        } catch (e) {
          failedNames.push(row.main)
          console.error(`[AI] ${row.main} 분석 실패`, e)
        }
      }
      try {
        const peakResult = await api.analyzeDailyPeak(date)
        if (peakResult.gemma_error) failedNames.push('피크타임')
        setReport(prev => prev ? { ...prev, peak_bucket: peakResult } : prev)
      } catch (e) {
        failedNames.push('피크타임')
        console.error('[AI] 피크타임 분석 실패', e)
      }
      try {
        await api.logDailyReportComplete(date, failedNames)
      } catch (e) {
        console.error('[AI] 생성 완료 로그 기록 실패', e)
      }
      const canNotify = await requestNotificationPermission()
      if (canNotify) {
        const url = `${window.location.origin}/report/daily?date=${date}`
        showReportNotification(statsData, url)
      }
    } catch (e) {
      alert(`보고서 생성 실패: ${e}`)
      setGenerating(false)
    } finally {
      setAiGenerating(false)
    }
  }

  const riskPct = report && report.total_count > 0
    ? (report.risk_total / report.total_count * 100).toFixed(1)
    : '0.0'

  const totalDelta = report?.prev_total_count != null ? report.total_count - report.prev_total_count : null
  const riskDelta = report?.prev_risk_total != null ? report.risk_total - report.prev_risk_total : null
  const prevRiskPct = report?.prev_risk_total != null && report?.prev_total_count != null
    ? report.prev_risk_total / Math.max(report.prev_total_count, 1) * 100 : null
  const riskPctDelta = prevRiskPct != null ? Math.round((Number(riskPct) - prevRiskPct) * 10) / 10 : null

  return (
    <div className="container" style={{ fontFamily: "'Pretendard', 'Segoe UI', system-ui, sans-serif" }}>

      {/* 날짜 선택 + 생성 버튼 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginBottom: 16 }}>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          style={{
            padding: '7px 12px', border: '1px solid #e2e8f0', borderRadius: 8,
            fontSize: 14, color: '#374151', background: '#fff',
          }}
        />
        <button
          onClick={handleGenerate}
          disabled={generating || aiGenerating || loading}
          style={{
            padding: '8px 18px',
            background: generating || aiGenerating ? '#94a3b8' : NAVY,
            color: '#fff', border: 'none', borderRadius: 8,
            cursor: generating ? 'default' : 'pointer',
            fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
          }}
        >
          {generating ? '집계 중...' : aiGenerating ? 'AI 분석 중...' : report ? '↻ 재생성' : '보고서 생성'}
        </button>
      </div>

      {/* 로딩 */}
      {loading && (
        <div className="section-card">
          <div className="loading">조회 중...</div>
        </div>
      )}

      {/* 미생성 */}
      {!loading && notFound && !generating && (
        <div className="section-card">
          <div style={{ padding: '40px 0', textAlign: 'center', color: '#94a3b8' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📄</div>
            <div style={{ fontSize: 14, marginBottom: 8, color: '#475569' }}>{date} 보고서가 없습니다.</div>
            <div style={{ fontSize: 13, color: '#cbd5e1' }}>
              "보고서 생성" 버튼을 클릭해 Gemma 분석을 시작하세요.
            </div>
          </div>
        </div>
      )}

      {/* 통계 집계 중 (1단계) */}
      {generating && !report && (
        <div className="section-card">
          <div style={{ padding: '40px 0', textAlign: 'center', color: '#64748b' }}>
            <div style={{ fontSize: 13, marginBottom: 8 }}>통계 집계 중...</div>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>DB 조회 중입니다</div>
          </div>
        </div>
      )}

      {/* 보고서 본문 */}
      {report && (
        <>
          {/* 그라디언트 헤더 배너 */}
          <div style={{
            background: `linear-gradient(135deg, ${NAVY} 0%, ${NAVY2} 100%)`,
            borderRadius: 16, padding: '28px 32px', marginBottom: 16,
            color: '#fff', boxShadow: '0 4px 20px rgba(30,60,114,.25)',
          }}>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.5px', marginBottom: 6 }}>
              일별 CS 보고서
            </div>
            <div style={{ fontSize: 15, opacity: 0.85 }}>
              보고서 기준일 {report.report_date}
            </div>
            {report.generated_at && (
              <div style={{ fontSize: 12, opacity: 0.55, marginTop: 4 }}>
                스냅샷 생성 {report.generated_at.slice(0, 16).replace('T', ' ')}
              </div>
            )}
          </div>

          {/* KPI 카드 3개 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.35fr 1.35fr', gap: 14, marginBottom: 16 }}>
            <KpiCard
              label="총 상담" value={report.total_count.toLocaleString()} unit="건" color={NAVY}
              delta={totalDelta} deltaUnit="건" deltaNeutral isSecondary
            />
            <KpiCard
              label="리스크 이슈" value={report.risk_total.toLocaleString()} unit="건" color={RISK_RED}
              delta={riskDelta} deltaUnit="건" deltaInvert
            />
            <KpiCard
              label="리스크 비율" value={riskPct} unit="%" color="#f59e0b"
              delta={riskPctDelta} deltaUnit="%p" deltaInvert
            />
          </div>

          {/* 리스크 카테고리 현황 — 바 차트 */}
          {report.risk_rows.length > 0 && (
            <div className="section-card">
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                marginBottom: 20, paddingBottom: 14, borderBottom: '1px solid #f1f5f9',
              }}>
                <h3 style={{ margin: 0, color: NAVY, fontSize: 22 }}>리스크 카테고리 현황</h3>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>해지·장애 등 위험 징후로 분류된 상담 유형별 건수입니다</span>
              </div>
              <RiskBarChart
                rows={report.risk_rows}
                onBarClick={(main, sub) => {
                  const matchingRow = report.risk_rows.find(r => r.main === main)
                  const allowedSubs = matchingRow?.subs?.map(s => s.sub) ?? (matchingRow ? [matchingRow.sub] : undefined)
                  setModalState({ main, initialSubs: sub ? [sub] : undefined, allowedSubs })
                }}
              />
            </div>
          )}

          {/* 카테고리별 AI 분석 */}
          <div className="section-card">
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              marginBottom: 16, paddingBottom: 14, borderBottom: '1px solid #f1f5f9',
            }}>
              <h3 style={{ margin: 0, color: NAVY, fontSize: 22 }}>카테고리별 AI 분석</h3>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>위험 유형마다 당일 가장 많이 접수된 항목을 AI가 분석합니다</span>
            </div>
            {report.risk_rows.length === 0 ? (
              <div style={{ color: '#94a3b8', fontSize: 13 }}>리스크 카테고리 데이터 없음</div>
            ) : (
              [...report.risk_rows].sort((a, b) => (b.main_total ?? b.count) - (a.main_total ?? a.count)).map((row, i) => (
                <RiskRowItem key={i} row={row} aiLoading={aiGenerating} />
              ))
            )}
          </div>

          {/* 피크타임 특이사항 */}
          <div className="section-card">
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              marginBottom: 6, paddingBottom: 12, borderBottom: '1px solid #f1f5f9',
            }}>
              <h3 style={{ margin: 0, color: NAVY, fontSize: 22 }}>피크타임 패턴 분석</h3>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>17시~20시 30분 구간에서 상담이 집중된 시간대를 찾아 AI가 패턴을 분석합니다</span>
            </div>
            {peakBuckets.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', gap: 14, fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>
                  <span><span style={{ color: '#ef4444', fontWeight: 700 }}>■</span> 최다 시간대</span>
                  <span><span style={{ color: '#3b82f6', fontWeight: 700 }}>■</span> 피크타임 구간 (17~20시)</span>
                  <span><span style={{ color: '#e2e8f0', fontWeight: 700 }}>■</span> 기타</span>
                </div>
                <div style={{ height: 160, position: 'relative' }}>
                  <HourlyBucketChart buckets={peakBuckets} onBarClick={b => setPeakModalBuckets([b])} />
                </div>
              </div>
            )}
            {!report.peak_bucket ? (
              aiGenerating
                ? <div style={{ fontSize: 13, color: '#94a3b8', fontStyle: 'italic' }}>AI 분석 중...</div>
                : <div style={{ fontSize: 13, color: '#94a3b8' }}>데이터 없음</div>
            ) : (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 14, fontWeight: 700, color: '#fff',
                    background: NAVY, borderRadius: 20, padding: '4px 14px',
                  }}>
                    {report.peak_bucket.bucket_start}~{report.peak_bucket.bucket_end}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: RISK_RED }}>
                    {report.peak_bucket.bucket_count}건
                  </span>
                  <span style={{ fontSize: 13, color: '#64748b' }}>
                    집중 (당일 피크타임 30분 구간 평균 {report.peak_bucket.avg_count}건)
                  </span>
                  {report.peak_bucket.pattern && (
                    <span style={{
                      fontSize: 12, fontWeight: 700, color: NAVY,
                      background: '#dbeafe', borderRadius: 20, padding: '3px 10px',
                    }}>
                      {report.peak_bucket.pattern} 반복
                    </span>
                  )}
                </div>
                {report.peak_bucket.summary ? (
                  <div style={{
                    fontSize: 13, color: '#374151', lineHeight: 1.7,
                    borderLeft: `3px solid ${NAVY}`, paddingLeft: 10,
                  }}>
                    {report.peak_bucket.summary}
                  </div>
                ) : report.peak_bucket.gemma_error ? (
                  <div style={{ fontSize: 12, color: RISK_RED }} title={report.peak_bucket.gemma_error}>
                    AI 분석 실패 — 다시 시도해주세요
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {report.anomaly_bucket && (
            <div className="section-card">
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                marginBottom: 6, paddingBottom: 12, borderBottom: '1px solid #f1f5f9',
              }}>
                <h3 style={{ margin: 0, color: NAVY, fontSize: 22 }}>이상 시간대 분석</h3>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>피크타임(17~20시)이 아닌데도 그보다 상담이 더 몰린 시간대가 있어 AI가 패턴을 분석합니다</span>
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 14, fontWeight: 700, color: '#fff',
                    background: RISK_RED, borderRadius: 20, padding: '4px 14px',
                  }}>
                    {report.anomaly_bucket.bucket_start}~{report.anomaly_bucket.bucket_end}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: RISK_RED }}>
                    {report.anomaly_bucket.bucket_count}건
                  </span>
                  <span style={{ fontSize: 13, color: '#64748b' }}>
                    집중 (당일 피크타임 최다 구간 {report.anomaly_bucket.peak_count}건보다 많음)
                  </span>
                  {report.anomaly_bucket.pattern && (
                    <span style={{
                      fontSize: 12, fontWeight: 700, color: NAVY,
                      background: '#dbeafe', borderRadius: 20, padding: '3px 10px',
                    }}>
                      {report.anomaly_bucket.pattern} 반복
                    </span>
                  )}
                </div>
                {report.anomaly_bucket.summary ? (
                  <div style={{
                    fontSize: 13, color: '#374151', lineHeight: 1.7,
                    borderLeft: `3px solid ${RISK_RED}`, paddingLeft: 10,
                  }}>
                    {report.anomaly_bucket.summary}
                  </div>
                ) : report.anomaly_bucket.gemma_error ? (
                  <div style={{ fontSize: 12, color: RISK_RED }} title={report.anomaly_bucket.gemma_error}>
                    AI 분석 실패 — 다시 시도해주세요
                  </div>
                ) : null}
              </div>
            </div>
          )}

          <div style={{ marginTop: 8 }}>
            <button
              onClick={() => setAiPanelOpen(v => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'none', border: '1px solid #e2e8f0', borderRadius: 8,
                padding: '6px 14px', fontSize: 12, color: '#64748b',
                cursor: 'pointer', marginBottom: aiPanelOpen ? 8 : 0,
              }}
            >
              <span>AI 분석 설정</span>
              <span>{aiPanelOpen ? '▴' : '▾'}</span>
            </button>
            {aiPanelOpen && (
              <CategoryTestPanel
                date={date}
                onCategoryResult={(main, summary, gemmaError) => {
                  setReport(prev => prev ? {
                    ...prev,
                    risk_rows: prev.risk_rows.map(r => r.main === main ? { ...r, summary, gemma_error: gemmaError } : r),
                  } : prev)
                }}
                onPeakResult={(peak) => {
                  setReport(prev => prev ? { ...prev, peak_bucket: peak } : prev)
                }}
              />
            )}
          </div>

        </>
      )}

      {modalState && report && (
        <CategoryMemoModal
          categoryMain={modalState.main}
          dateStart={report.report_date}
          dateEnd={report.report_date}
          initialSubs={modalState.initialSubs}
          allowedSubs={modalState.allowedSubs}
          onClose={() => setModalState(null)}
        />
      )}

      {peakModalBuckets && report && (
        <PeakMemoModal
          buckets={peakModalBuckets}
          date={report.report_date}
          onClose={() => setPeakModalBuckets(null)}
        />
      )}
    </div>
  )
}
