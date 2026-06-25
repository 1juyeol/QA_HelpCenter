// 주간 CS 보고서 페이지. 선택한 주(월~일)의 CS 통계를 종합적으로 보여준다.
//
// 레이아웃 (위→아래):
//   1. 컨트롤바 — 주차 선택(드롭다운) + 보고서 생성 버튼
//   2. 그라디언트 헤더 배너 (주 범위 표시)
//   3. KPI 카드 4개 — 총상담 / 일평균 / 리스크 CS / SQI (평일 기준)
//   4. 일별 건수 바(HTML, 평일=네이비·주말=회색) + SQI 추이 라인(Chart.js)
//   5. 전체 카테고리 비율 도넛(Chart.js) + 리스크 스택 바(Chart.js)
//   6. 리스크 카테고리별 AI 분석 카드 (전체 폭)
//   7. 피크타임 요일별 바(HTML, 최다=빨강) + 주간 종합 AI 분석 텍스트
//
// 데이터 흐름:
//   GET  /api/report/weekly?week_start=YYYY-MM-DD  → 저장된 보고서 (없으면 404)
//   POST /api/report/weekly/generate?week_start=YYYY-MM-DD → Gemma 기반 보고서 생성
//
// 의존: api/client.ts (WeeklyReport 타입, fetchWeeklyReport, generateWeeklyReport)
//       Chart.js (SQI 라인, 도넛, 리스크 스택 바)

import { useEffect, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import {
  api,
  type WeeklyReport as WeeklyReportType,
  type WeeklyDayCount,
} from '../../api/client'
import CategoryMemoModal from '../../components/CategoryMemoModal'

const NAVY = '#1e3c72'
const NAVY2 = '#2a5298'
const RISK_RED = '#ef4444'

const RISK_MAINS = [
  '네트워크·앱 오류',
  '기기·하드웨어 오류',
  '교재·물류·배송',
]

// 선 차트 범례 표기 — 대분류 명칭 그대로 사용
const RISK_DISPLAY_LABEL: Record<string, string> = {
  '네트워크·앱 오류':  '네트워크·앱 오류',
  '기기·하드웨어 오류': '기기·하드웨어 오류',
  '교재·물류·배송':   '교재·물류·배송',
}

// 카테고리 공유 팔레트 — 도넛과 리스크 스택 바가 같은 색 사용
const PALETTE = [
  '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#ef4444', '#84cc16', '#64748b',
]


const DAYS_KO = ['월', '화', '수', '목', '금', '토', '일']

// ── 유틸 ──────────────────────────────────────────────────────────────────────

function fmtDate(dateStr: string): string {
  const dow = new Date(dateStr + 'T12:00:00').getDay()
  const idx = (dow + 6) % 7
  return `${dateStr.slice(5).replace('-', '/')}(${DAYS_KO[idx]})`
}

function getWeekLabel(weekStart: string): string {
  const d = new Date(weekStart + 'T12:00:00')
  const year = d.getFullYear()
  const month = d.getMonth()               // 0-based
  const firstDay = new Date(year, month, 1)
  const firstDow = firstDay.getDay()       // 0=일 ~ 6=토
  const daysToFirstMon = (1 - firstDow + 7) % 7
  const firstMonDate = 1 + daysToFirstMon
  const weekNum = Math.floor((d.getDate() - firstMonDate) / 7) + 1
  return `${month + 1}월 ${weekNum}주차`
}

function getRecentMondays(count = 8): string[] {
  const mondays: string[] = []
  const today = new Date()
  const dow = today.getDay()                     // 0=일 ~ 6=토
  const offsetToMon = dow === 0 ? 6 : dow - 1   // 이번 주 월요일까지 오프셋
  for (let i = 0; i < count; i++) {
    const d = new Date(today)
    d.setDate(today.getDate() - offsetToMon - i * 7)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    mondays.push(`${y}-${m}-${dd}`)
  }
  return mondays
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

// ── KPI 카드 ──────────────────────────────────────────────────────────────────

function DeltaBadge({ delta, unit, invert, deltaPct }: { delta: number | null | undefined; unit: string; invert?: boolean; deltaPct?: number | null }) {
  if (delta == null) return null
  if (delta === 0) return <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 5 }}>전주 동일</div>
  const isPositive = delta > 0
  const color = invert
    ? (isPositive ? '#ef4444' : '#16a34a')
    : '#f59e0b'
  const arrow = isPositive ? '↑' : '↓'
  return (
    <div style={{ fontSize: 13, color, fontWeight: 600, marginTop: 5 }}>
      {arrow} {isPositive ? '+' : ''}{delta}{unit}
      {deltaPct != null && <span style={{ fontWeight: 500, marginLeft: 3 }}>({isPositive ? '+' : ''}{deltaPct}%)</span>}
      <span style={{ color: '#94a3b8', fontWeight: 400, marginLeft: 4 }}>전주 대비</span>
    </div>
  )
}

const SUB_RANK_COLORS = ['#ef4444', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#64748b', '#0d9488']


function TwoWeekSubLineChart({
  data,
  prevData,
  onChartClick,
}: {
  data: Array<{ date: string } & Record<string, number>>
  prevData: Array<{ date: string } & Record<string, number>>
  onChartClick?: (date: string | null, sub: string | null) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)

  useEffect(() => {
    if (!canvasRef.current || data.length === 0 || prevData.length === 0) return
    chartRef.current?.destroy()

    const allDates = [...prevData.map(d => d.date), ...data.map(d => d.date)]
    const labels = allDates.map(d => fmtDate(d))

    const subs = Object.keys(data[0])
      .filter(k => k !== 'date')
      .sort((a, b) => {
        const sumA = data.reduce((s, d) => s + ((d[a] as number) ?? 0), 0)
        const sumB = data.reduce((s, d) => s + ((d[b] as number) ?? 0), 0)
        return sumB - sumA
      })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const datasets: any[] = subs.map((sub, i) => {
      const color = SUB_RANK_COLORS[i % SUB_RANK_COLORS.length]
      const combined = [
        ...prevData.map(d => (d[sub] as number) ?? 0),
        ...data.map(d => (d[sub] as number) ?? 0),
      ]
      return {
        label: sub,
        data: combined,
        tension: 0.3,
        borderColor: color,
        backgroundColor: 'transparent',
        pointRadius: 4,
        pointBackgroundColor: color,
        borderWidth: 3.5,
      }
    })

    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { left: 4, right: 4, bottom: 4 } },
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 10, font: { size: 12 }, padding: 14 } },
        },
        scales: {
          y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { font: { size: 13 }, padding: 10 } },
          x: { grid: { display: false }, ticks: { font: { size: 13 }, padding: 10 } },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onClick: (_: unknown, elements: any[]) => {
          const date = elements.length > 0 ? (allDates[elements[0].index] ?? null) : null
          const sub = elements.length > 0 ? (datasets[elements[0].datasetIndex]?.label ?? null) : null
          onChartClick?.(date, sub)
        },
      },
    })
    return () => { chartRef.current?.destroy() }
  }, [data, prevData])

  return <canvas ref={canvasRef} />
}

function KpiCard({
  label, value, unit, color, sub, delta, deltaUnit, deltaInvert, deltaPct, isSecondary,
}: {
  label: string; value: string; unit: string; color: string; sub?: string
  delta?: number | null; deltaUnit?: string; deltaInvert?: boolean; deltaPct?: number | null; isSecondary?: boolean
}) {
  return (
    <div style={{
      background: '#fff', borderRadius: 14,
      padding: isSecondary ? '16px 20px' : '22px 26px',
      boxShadow: isSecondary ? '0 1px 4px rgba(0,0,0,.06)' : '0 2px 10px rgba(0,0,0,.09)',
      borderTop: `${isSecondary ? 3 : 5}px solid ${color}`,
    }}>
      <div style={{
        fontSize: 13, fontWeight: 700, color: '#94a3b8',
        textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8,
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: isSecondary ? 42 : 54, fontWeight: 800, color, lineHeight: 1 }}>{value}</span>
        <span style={{ fontSize: isSecondary ? 19 : 24, color: '#64748b', fontWeight: 600 }}>{unit}</span>
      </div>
      {sub && <div style={{ fontSize: 12, color: '#64748b', marginTop: 5, fontWeight: 500 }}>{sub}</div>}
      <DeltaBadge delta={delta} unit={deltaUnit ?? ''} invert={deltaInvert} deltaPct={deltaPct} />
    </div>
  )
}

// ── 일별 건수 바 (Chart.js) ───────────────────────────────────────────────────

function DailyBar({ dailyCounts }: { dailyCounts: WeeklyDayCount[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)

  useEffect(() => {
    if (!canvasRef.current || dailyCounts.length === 0) return
    chartRef.current?.destroy()

    const maxCount = Math.max(...dailyCounts.filter(d => !d.is_weekend).map(d => d.count), 1)
    const bgColors = dailyCounts.map(d => {
      if (d.is_weekend) return '#e2e8f0'
      return d.count === maxCount ? '#ef4444' : '#3b82f6'
    })

    const datalabels = {
      id: 'datalabels',
      afterDatasetsDraw(chart: Chart) {
        const { ctx } = chart
        chart.data.datasets.forEach((_ds, di) => {
          chart.getDatasetMeta(di).data.forEach((bar, idx) => {
            const val = (chart.data.datasets[di].data[idx] as number)
            if (!val) return
            ctx.save()
            ctx.font = 'bold 11px Pretendard, sans-serif'
            ctx.fillStyle = '#374151'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'bottom'
            ctx.fillText(val.toLocaleString(), bar.x, bar.y - 3)
            ctx.restore()
          })
        })
      },
    }

    chartRef.current = new Chart(canvasRef.current, {
      type: 'bar',
      data: {
        labels: dailyCounts.map(d => fmtDate(d.date)),
        datasets: [{
          data: dailyCounts.map(d => d.count),
          backgroundColor: bgColors,
          borderRadius: 4,
          borderSkipped: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 20 } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => `${(ctx.raw as number).toLocaleString()}건` } },
        },
        scales: {
          y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { font: { size: 13 }, padding: 10 } },
          x: { grid: { display: false }, ticks: { font: { size: 13 }, padding: 10 } },
        },
      },
      plugins: [datalabels],
    })

    return () => { chartRef.current?.destroy() }
  }, [dailyCounts])

  return <canvas ref={canvasRef} />
}

// ── 카테고리 AI 분석 패널 ──────────────────────────────────────────────────────

const WEEKLY_TEST_TARGETS = [...RISK_MAINS, '종합 브리핑']

function WeeklyTestPanel({
  weekStart,
  onCategoryResult,
  onSummaryResult,
}: {
  weekStart: string
  onCategoryResult: (main: string, summary: string) => void
  onSummaryResult: (summary: string) => void
}) {
  const [target, setTarget] = useState(WEEKLY_TEST_TARGETS[0])
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ label: string; summary: string; insufficient_data?: boolean } | null>(null)
  const [error, setError] = useState('')

  async function run() {
    setRunning(true)
    setResult(null)
    setError('')
    try {
      if (target === '종합 브리핑') {
        const r = await api.analyzeWeeklySummary(weekStart)
        setResult({ label: '종합 브리핑', summary: r.summary })
        onSummaryResult(r.summary)
      } else {
        const r = await api.analyzeWeeklyCategory(weekStart, target)
        setResult({ label: target, summary: r.summary, insufficient_data: r.insufficient_data })
        onCategoryResult(target, r.summary)
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div style={{ marginTop: 16, padding: '14px 18px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10 }}>AI 분석 실행</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <select
          value={target}
          onChange={e => { setTarget(e.target.value); setResult(null); setError('') }}
          style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13 }}
        >
          {WEEKLY_TEST_TARGETS.map(t => <option key={t} value={t}>{RISK_DISPLAY_LABEL[t] ?? t}</option>)}
        </select>
        <button
          onClick={run}
          disabled={running}
          style={{
            padding: '6px 14px', background: running ? '#94a3b8' : NAVY,
            color: '#fff', border: 'none', borderRadius: 6,
            cursor: running ? 'default' : 'pointer', fontSize: 13, fontWeight: 600,
          }}
        >
          {running ? '분석 중...' : '분석 실행'}
        </button>
      </div>
      {error && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 6 }}>{error}</div>}
      {result && (
        <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.6 }}>
          <div style={{ marginBottom: 4 }}>
            <span style={{ fontWeight: 700 }}>{RISK_DISPLAY_LABEL[result.label] ?? result.label}</span>
            {result.insufficient_data && <span style={{ color: '#f59e0b', marginLeft: 8 }}>데이터 부족</span>}
          </div>
          {result.summary && (
            <div style={{ background: '#f0f4fb', borderRadius: 6, padding: '7px 12px', borderLeft: `3px solid ${NAVY}`, fontSize: 13 }}>
              {result.summary}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── 메인 페이지 ───────────────────────────────────────────────────────────────

export default function WeeklyReport() {
  const mondays = getRecentMondays()
  const [weekStart, setWeekStart] = useState(mondays[1])   // 기본: 직전 주
  const [report, setReport] = useState<WeeklyReportType | null>(null)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [aiGenerating, setAiGenerating] = useState(false)
  const [notFound, setNotFound] = useState(false)

  type ModalState = { main: string; dateStart: string; dateEnd: string; initialSubs?: string[]; fullDateStart?: string; fullDateEnd?: string; allowedSubs?: string[] }
  const [hiddenDonutItems, setHiddenDonutItems] = useState<Set<number>>(new Set())
  const [testPanelOpen, setTestPanelOpen] = useState(false)
  const [modalState, setModalState] = useState<ModalState | null>(null)

  // Chart.js 캔버스 및 인스턴스
  const sqiRef      = useRef<HTMLCanvasElement>(null)
  const donutRef    = useRef<HTMLCanvasElement>(null)
  const sqiChart    = useRef<Chart | null>(null)
  const donutChart  = useRef<Chart | null>(null)

  useEffect(() => {
    loadReport()
  }, [weekStart])

  // 언마운트 시 차트 정리
  useEffect(() => () => {
    sqiChart.current?.destroy()
    donutChart.current?.destroy()
  }, [])

  // 보고서 변경 시 차트 재생성
  useEffect(() => {
    if (!report) {
      sqiChart.current?.destroy()
      donutChart.current?.destroy()
      return
    }
    renderSqiChart(report)
    renderDonutChart(report)
    setHiddenDonutItems(new Set())
  }, [report])

  function toggleDonutItem(i: number) {
    donutChart.current?.toggleDataVisibility(i)
    donutChart.current?.update()
    setHiddenDonutItems(prev => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }

  async function loadReport() {
    setLoading(true)
    setReport(null)
    setNotFound(false)
    try {
      const r = await api.fetchWeeklyReport(weekStart)
      setReport(r)
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
      const statsData = await api.generateWeeklyReportStats(weekStart)
      setReport(statsData)
      setNotFound(false)
      setGenerating(false)

      // 2단계: AI 분석 → 요약 채움
      setAiGenerating(true)
      const fullData = await api.generateWeeklyReport(weekStart)
      setReport(fullData)
    } catch (e) {
      console.error('보고서 생성 실패:', e)
      setGenerating(false)
    } finally {
      setAiGenerating(false)
    }
  }

  function renderSqiChart(r: WeeklyReportType) {
    if (!sqiRef.current || r.sqi_daily.length === 0) return
    sqiChart.current?.destroy()
    const baseline = Math.round(r.risk_total / Math.max(r.total_weekday, 1) * 1000) / 10
    sqiChart.current = new Chart(sqiRef.current, {
      type: 'line',
      data: {
        labels: r.sqi_daily.map(p => fmtDate(p.date)),
        datasets: [
          {
            data: r.sqi_daily.map(p => p.sqi),
            borderColor: NAVY,
            backgroundColor: 'rgba(30,60,114,0.07)',
            pointBackgroundColor: r.sqi_daily.map(p => p.sqi > baseline ? RISK_RED : NAVY),
            pointRadius: r.sqi_daily.map(p => p.sqi > baseline ? 9 : 4),
            pointBorderColor: r.sqi_daily.map(p => p.sqi > baseline ? '#fff' : NAVY),
            pointBorderWidth: r.sqi_daily.map(p => p.sqi > baseline ? 2 : 1),
            tension: 0.3,
            fill: true,
            segment: {
              borderColor: (ctx: { p0DataIndex: number; p1DataIndex: number }) => {
                const s0 = r.sqi_daily[ctx.p0DataIndex]?.sqi ?? 0
                const s1 = r.sqi_daily[ctx.p1DataIndex]?.sqi ?? 0
                return s0 > baseline || s1 > baseline ? RISK_RED : NAVY
              },
              borderWidth: (ctx: { p0DataIndex: number; p1DataIndex: number }) => {
                const s0 = r.sqi_daily[ctx.p0DataIndex]?.sqi ?? 0
                const s1 = r.sqi_daily[ctx.p1DataIndex]?.sqi ?? 0
                return s0 > baseline || s1 > baseline ? 2.5 : 1.5
              },
            },
          },
          {
            data: r.sqi_daily.map(() => baseline),
            borderColor: '#94a3b8',
            borderDash: [4, 4],
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tooltip: { callbacks: { label: (ctx: any) => `${ctx.parsed.y}%` } },
        },
        scales: {
          y: { beginAtZero: true, ticks: { callback: v => `${v}%`, font: { size: 13 }, padding: 10 } },
          x: { grid: { display: false }, ticks: { font: { size: 13 }, padding: 10 } },
        },
      },
    })
  }

  function renderDonutChart(r: WeeklyReportType) {
    if (!donutRef.current || r.category_breakdown.length === 0) return
    donutChart.current?.destroy()
    const sorted = [...r.category_breakdown].sort((a, b) => b.count - a.count)
    const total = sorted.reduce((s, c) => s + c.count, 0)
    donutChart.current = new Chart(donutRef.current, {
      type: 'doughnut',
      data: {
        labels: sorted.map(c => c.main),
        datasets: [{
          data: sorted.map(c => c.count),
          backgroundColor: sorted.map((_, i) => PALETTE[i % PALETTE.length]),
          borderColor: '#fff',
          borderWidth: 2,
        }],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: {
        cutout: '58%',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx: any) => {
                const val = ctx.parsed as number
                const pct = ((val / total) * 100).toFixed(1)
                return `  ${val.toLocaleString()}건 (${pct}%)`
              },
            },
          },
        },
        onClick: (_: unknown, elements: any[]) => {
          if (elements.length === 0) return
          const idx = elements[0].index
          setModalState({ main: sorted[idx].main, dateStart: r.week_start, dateEnd: r.week_end })
        },
      } as any,
    })
  }


  const weekEnd = addDays(weekStart, 6)
  const riskPct = report && report.total_weekday > 0
    ? (report.risk_total / report.total_weekday * 100).toFixed(1)
    : '0.0'

  const totalDelta = report?.prev_total_weekday != null
    ? report.total_weekday - report.prev_total_weekday
    : null
  const dailyAvgDelta = report?.prev_daily_avg != null
    ? Math.round((report.daily_avg - report.prev_daily_avg) * 10) / 10
    : null
  const riskDelta = report?.prev_risk_total != null
    ? report.risk_total - report.prev_risk_total
    : null
  const prevRiskPct = report?.prev_risk_total != null && report?.prev_total_weekday != null
    ? report.prev_risk_total / Math.max(report.prev_total_weekday, 1) * 100
    : null
  const riskPctDelta = prevRiskPct != null
    ? Math.round((Number(riskPct) - prevRiskPct) * 10) / 10
    : null

  const totalDeltaPct = report?.prev_total_weekday && report.prev_total_weekday > 0
    ? Math.round((report.total_weekday - report.prev_total_weekday) / report.prev_total_weekday * 100)
    : null
  const collectedWeekdays = report
    ? report.daily_counts.filter(d => !d.is_weekend && d.count > 0).length
    : 0

  const sortedBreakdown = report ? [...report.category_breakdown].sort((a, b) => b.count - a.count) : []
  const totalCatCount = sortedBreakdown.reduce((s, c) => s + c.count, 0)

  return (
    <div className="container" style={{ fontFamily: "'Pretendard', 'Segoe UI', system-ui, sans-serif" }}>

      {/* 컨트롤바 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginBottom: 16 }}>
        <select
          value={weekStart}
          onChange={e => setWeekStart(e.target.value)}
          style={{
            padding: '7px 12px', border: '1px solid #e2e8f0', borderRadius: 8,
            fontSize: 14, color: '#374151', background: '#fff',
          }}
        >
          {mondays.map(m => (
            <option key={m} value={m}>{getWeekLabel(m)} ({m} ~ {addDays(m, 6)})</option>
          ))}
        </select>
        <button
          onClick={handleGenerate}
          disabled={generating || aiGenerating || loading}
          style={{
            padding: '8px 18px',
            background: generating || aiGenerating ? '#94a3b8' : NAVY,
            color: '#fff', border: 'none', borderRadius: 8,
            cursor: generating || aiGenerating ? 'default' : 'pointer',
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

      {/* 통계 집계 중 (1단계) */}
      {generating && !report && (
        <div className="section-card">
          <div style={{ padding: '40px 0', textAlign: 'center', color: '#64748b' }}>
            <div style={{ fontSize: 13, marginBottom: 8 }}>통계 집계 중...</div>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>DB 조회 중입니다</div>
          </div>
        </div>
      )}

      {/* 보고서 없음 */}
      {!loading && !generating && notFound && (
        <div className="section-card">
          <div style={{ padding: '40px 0', textAlign: 'center', color: '#94a3b8' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
            <div style={{ fontSize: 14, marginBottom: 8, color: '#475569' }}>
              {weekStart} ~ {weekEnd} 보고서가 없습니다.
            </div>
            <div style={{ fontSize: 13, color: '#cbd5e1' }}>
              "보고서 생성" 버튼을 클릭해 Gemma 분석을 시작하세요.
            </div>
          </div>
        </div>
      )}

      {/* 보고서 본문 */}
      {report && (
        <>
          {/* 헤더 배너 */}
          <div style={{
            background: `linear-gradient(135deg, ${NAVY} 0%, ${NAVY2} 100%)`,
            borderRadius: 16, padding: '28px 32px', marginBottom: 16,
            color: '#fff', boxShadow: '0 4px 20px rgba(30,60,114,.25)',
          }}>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.5px', marginBottom: 6 }}>
              {getWeekLabel(report.week_start)} CS 보고서
            </div>
            <div style={{ fontSize: 15, opacity: 0.8 }}>
              {report.week_start} ~ {report.week_end}
            </div>
          </div>

          {/* KPI 4개 — 좌측 2개(운영 규모) 보조, 우측 2개(리스크) 강조 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.35fr 1.35fr', gap: 14, marginBottom: 16 }}>
            <KpiCard
              label="총 상담" value={report.total_weekday.toLocaleString()} unit="건"
              color={NAVY} sub="평일 기준"
              delta={totalDelta} deltaUnit="건" deltaPct={totalDeltaPct} isSecondary
            />
            <KpiCard
              label="일 평균" value={report.daily_avg.toLocaleString()} unit="건/일"
              color={NAVY2}
              sub={collectedWeekdays > 0 ? `집계 완료 ${collectedWeekdays}일 기준` : undefined}
              delta={dailyAvgDelta} deltaUnit="건/일" isSecondary
            />
            <KpiCard
              label="리스크 CS" value={report.risk_total.toLocaleString()} unit="건"
              color={RISK_RED}
              delta={riskDelta} deltaUnit="건" deltaInvert
            />
            <KpiCard
              label="리스크율" value={riskPct} unit="%"
              color={Number(riskPct) > 20 ? RISK_RED : '#4f46e5'}
              delta={riskPctDelta} deltaUnit="%p" deltaInvert
            />
          </div>

          {/* 일별 건수 + SQI */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div className="section-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 14, borderBottom: '1px solid #f1f5f9' }}>
                <h2 style={{ margin: 0, fontSize: 22, color: NAVY }}>일별 CS 건수</h2>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>최다 요일은 빨간색, 주말은 회색으로 표시합니다</span>
              </div>
              <div style={{ height: 200, position: 'relative' }}>
                <DailyBar dailyCounts={report.daily_counts} />
              </div>
            </div>
            <div className="section-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, paddingBottom: 14, borderBottom: '1px solid #f1f5f9' }}>
                <h2 style={{ margin: 0, fontSize: 22, color: NAVY }}>리스크율 추이</h2>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>일별 리스크율 변화를 주 평균 기준으로 표시합니다</span>
              </div>
              <div style={{ display: 'flex', gap: 14, marginBottom: 12, fontSize: 11, color: '#64748b' }}>
                <span><span style={{ color: NAVY, fontWeight: 700 }}>●</span> 주 평균 이하</span>
                <span><span style={{ color: RISK_RED, fontWeight: 700 }}>●</span> 주 평균 초과</span>
                <span style={{ color: '#94a3b8' }}>- - 주 평균선 ({riskPct}%)</span>
              </div>
              <div style={{ height: 200, position: 'relative' }}>
                {report.sqi_daily.length === 0
                  ? <div style={{ fontSize: 13, color: '#94a3b8', paddingTop: 60, textAlign: 'center' }}>데이터 없음</div>
                  : <canvas ref={sqiRef} />
                }
              </div>
            </div>
          </div>

          {/* 도넛 — 좌: 차트+범례, 우: 상위 유형 요약 */}
          <div className="section-card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 14, borderBottom: '1px solid #f1f5f9' }}>
              <h2 style={{ margin: 0, fontSize: 22, color: NAVY }}>이번 주 CS 유형 분포</h2>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>전체 상담을 카테고리별로 분류한 비율입니다</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>
              {/* 차트 */}
              <div>
                <div style={{ height: 220, position: 'relative' }}>
                  <canvas ref={donutRef} />
                </div>
                {/* 커스텀 범례 */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 12 }}>
                  {sortedBreakdown.map((cat, i) => {
                    const hidden = hiddenDonutItems.has(i)
                    return (
                      <div
                        key={cat.main}
                        onClick={() => toggleDonutItem(i)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5, fontSize: 12,
                          color: hidden ? '#cbd5e1' : '#374151',
                          cursor: 'pointer', userSelect: 'none',
                          textDecoration: hidden ? 'line-through' : 'none',
                        }}
                      >
                        <div style={{ width: 9, height: 9, borderRadius: 2, background: hidden ? '#e2e8f0' : PALETTE[i % PALETTE.length], flexShrink: 0 }} />
                        {cat.main} {cat.count.toLocaleString()}건
                      </div>
                    )
                  })}
                </div>
              </div>
              {/* 상위 유형 요약 */}
              <div style={{ paddingLeft: 8, borderLeft: '1px solid #f1f5f9' }}>
                <h3 style={{ margin: '0 0 14px', fontSize: 20, fontWeight: 700, color: '#1e293b' }}>이번 주 주요 유형</h3>
                {sortedBreakdown.filter(c => c.main !== '기타').slice(0, 3).map((cat, rank) => {
                  const i = sortedBreakdown.findIndex(c => c.main === cat.main)
                  const pct = totalCatCount > 0 ? Math.round(cat.count / totalCatCount * 100) : 0
                  return (
                    <div
                      key={cat.main}
                      onClick={() => setModalState({ main: cat.main, dateStart: report.week_start, dateEnd: report.week_end })}
                      style={{ marginBottom: 14, cursor: 'pointer' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                        <span style={{ fontSize: 15, color: '#374151' }}>
                          <span style={{ color: '#94a3b8', fontWeight: 700, marginRight: 6 }}>{rank + 1}</span>
                          {cat.main}
                        </span>
                        <span style={{ fontSize: 15, fontWeight: 700, color: PALETTE[i % PALETTE.length] }}>{pct}%</span>
                      </div>
                      <div style={{ height: 4, background: '#f1f5f9', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: PALETTE[i % PALETTE.length], borderRadius: 2 }} />
                      </div>
                    </div>
                  )
                })}
                {sortedBreakdown.length >= 2 && totalCatCount > 0 && (() => {
                  const meaningful = sortedBreakdown.filter(c => c.main !== '기타')
                  const top2Pct = Math.round(meaningful.slice(0, 2).reduce((s, c) => s + c.count, 0) / totalCatCount * 100)
                  return (
                    <div style={{ marginTop: 4, padding: '10px 12px', background: '#f8fafc', borderRadius: 8, fontSize: 14, color: '#64748b', lineHeight: 1.6 }}>
                      상위 2개 유형이 전체의 <strong style={{ color: '#ef4444' }}>{top2Pct}%</strong>를 차지합니다.
                    </div>
                  )
                })()}
              </div>
            </div>
          </div>

          {/* 리스크 카테고리별 AI 분석 */}
          {report.risk_rows.length > 0 && (
          <div className="section-card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 14, borderBottom: '1px solid #f1f5f9' }}>
              <h2 style={{ margin: 0, fontSize: 22, color: NAVY }}>리스크 카테고리별 AI 분석</h2>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>리스크 카테고리의 소분류 추이와 AI 요약을 함께 확인합니다</span>
            </div>
            <div>
              {[...report.risk_rows].sort((a, b) => b.count - a.count).map((row) => {
                  const cardTopSub = (() => {
                    const days = report.risk_sub_stack?.[row.main]
                    if (!days) return null
                    const totals = days.reduce((acc, day) => {
                      Object.entries(day).forEach(([k, v]) => { if (k !== 'date') acc[k] = (acc[k] ?? 0) + (v as number) })
                      return acc
                    }, {} as Record<string, number>)
                    return Object.entries(totals).sort(([, a], [, b]) => b - a)[0]?.[0] ?? null
                  })()
                  return (
                    <div key={row.main} style={{
                      background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0',
                      marginBottom: 12, overflow: 'hidden',
                    }}>
                      <div style={{ padding: '12px 16px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontWeight: 700, fontSize: 20, color: '#1e293b' }}>
                            {RISK_DISPLAY_LABEL[row.main] ?? row.main}
                          </span>
                          <span style={{
                            fontSize: 16, fontWeight: 700, color: RISK_RED,
                            background: '#fef2f2', borderRadius: 6,
                            padding: '2px 8px', border: '1px solid #fecaca', flexShrink: 0,
                          }}>
                            {row.count}건
                          </span>
                        </div>
                        {cardTopSub && (
                          <div style={{ fontSize: 14, color: '#64748b', marginTop: 4 }}>
                            이번 주 주요 세부 유형: <strong style={{ color: '#475569' }}>{cardTopSub}</strong>
                          </div>
                        )}
                      </div>
                      <div style={{ padding: '14px 16px' }}>
                      {report.risk_sub_stack?.[row.main] && report.risk_sub_stack_prev?.[row.main] && (() => {
                        const prevStack = report.risk_sub_stack_prev[row.main]
                        const curStack  = report.risk_sub_stack[row.main]
                        const chartStart = prevStack[0]?.date ?? report.week_start
                        const chartEnd   = curStack[curStack.length - 1]?.date ?? report.week_end
                        const riskSubs = Object.keys(curStack[0] ?? {}).filter(k => k !== 'date')
                        return (
                          <div style={{ marginBottom: 14, padding: '12px 0', borderTop: '1px dashed #e2e8f0' }}>
                            <div style={{ height: 220, position: 'relative' }}>
                              <TwoWeekSubLineChart
                                data={curStack}
                                prevData={prevStack}
                                onChartClick={(date, sub) => { if (!date) return; setModalState({ main: row.main, dateStart: date, dateEnd: date, initialSubs: sub ? [sub] : undefined, fullDateStart: chartStart, fullDateEnd: chartEnd, allowedSubs: riskSubs }) }}
                              />
                            </div>
                          </div>
                        )
                      })()}
                      {row.summary
                        ? <div style={{
                              fontSize: 13, color: '#374151', lineHeight: 1.7,
                              background: '#f0f4fb', borderRadius: 6,
                              padding: '7px 12px', borderLeft: `3px solid ${NAVY}`,
                              marginBottom: 8, whiteSpace: 'pre-line',
                            }}>
                            {row.summary}
                          </div>
                        : <p style={{ margin: '0 0 8px', fontSize: 13 }}>
                            {aiGenerating
                              ? <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>AI 분석 중...</span>
                              : <span style={{ color: '#94a3b8' }}>분석 없음</span>
                            }
                          </p>
                      }
                      <button
                        onClick={() => {
                          const prevStack = report.risk_sub_stack_prev?.[row.main]
                          const curStack  = report.risk_sub_stack?.[row.main]
                          const chartStart = prevStack?.[0]?.date ?? report.week_start
                          const chartEnd   = curStack?.[curStack.length - 1]?.date ?? report.week_end
                          const riskSubs = Object.keys(curStack?.[0] ?? {}).filter(k => k !== 'date')
                          setModalState({ main: row.main, dateStart: chartStart, dateEnd: chartEnd, fullDateStart: chartStart, fullDateEnd: chartEnd, allowedSubs: riskSubs })
                        }}
                        style={{
                          fontSize: 12, color: '#64748b', background: 'none',
                          border: '1px solid #e2e8f0', borderRadius: 5,
                          padding: '4px 14px', cursor: 'pointer',
                        }}
                      >
                        전체 메모 보기
                      </button>
                      </div>
                    </div>
                  )
                })}
            </div>
          </div>
          )}

          {/* 주간 종합 분석 (전체 폭) */}
          <div className="section-card">
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #f1f5f9',
            }}>
              <h2 style={{ margin: 0, color: NAVY, fontSize: 22 }}>이번 주 CS 종합 브리핑</h2>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>이번 주 CS 전반을 AI가 핵심 패턴 중심으로 종합 분석합니다</span>
            </div>
            {report.weekly_summary
              ? (
                <div style={{
                  fontSize: 13, color: '#374151', lineHeight: 1.7,
                  background: '#f0f4fb', borderRadius: 6,
                  padding: '10px 14px', borderLeft: `3px solid ${NAVY}`,
                  whiteSpace: 'pre-line',
                }}>
                  {report.weekly_summary}
                </div>
              )
              : aiGenerating
                ? <div style={{ fontSize: 13, color: '#94a3b8', fontStyle: 'italic' }}>AI 분석 중...</div>
                : <div style={{ fontSize: 13, color: '#94a3b8' }}>분석 없음</div>
            }
          </div>

          <div style={{ marginTop: 8 }}>
            <button
              onClick={() => setTestPanelOpen(o => !o)}
              style={{
                fontSize: 12, color: '#94a3b8', background: 'none',
                border: '1px solid #e2e8f0', borderRadius: 6,
                padding: '4px 12px', cursor: 'pointer',
              }}
            >
              분석 기준 설정 {testPanelOpen ? '▴' : '▾'}
            </button>
            {testPanelOpen && (
              <WeeklyTestPanel
                weekStart={weekStart}
                onCategoryResult={(main, summary) => {
                  setReport(prev => prev ? {
                    ...prev,
                    risk_rows: prev.risk_rows.map(r => r.main === main ? { ...r, summary } : r),
                  } : prev)
                }}
                onSummaryResult={(summary) => {
                  setReport(prev => prev ? { ...prev, weekly_summary: summary } : prev)
                }}
              />
            )}
          </div>
        </>
      )}

      {modalState && (
        <CategoryMemoModal
          categoryMain={modalState.main}
          dateStart={modalState.dateStart}
          dateEnd={modalState.dateEnd}
          initialSubs={modalState.initialSubs}
          allowedSubs={modalState.allowedSubs}
          fullDateStart={modalState.fullDateStart}
          fullDateEnd={modalState.fullDateEnd}
          onClose={() => setModalState(null)}
        />
      )}
    </div>
  )
}
