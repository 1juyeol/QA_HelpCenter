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
//   POST /api/report/weekly/generate?week_start=YYYY-MM-DD → Ollama 기반 보고서 생성
//
// 의존: api/client.ts (WeeklyReport 타입, fetchWeeklyReport, generateWeeklyReport)
//       Chart.js (SQI 라인, 도넛, 리스크 스택 바)

import { useEffect, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import {
  api,
  type WeeklyReport as WeeklyReportType,
  type WeeklyDayCount,
  type WeeklyMemosPage,
} from '../../api/client'

const NAVY = '#1e3c72'
const NAVY2 = '#2a5298'
const RISK_RED = '#ef4444'
const WEEKEND_GREY = '#94a3b8'

const RISK_MAINS = [
  '네트워크·앱 오류',
  '기기·하드웨어 오류',
  '미납·결제',
  '해지·유지 상담',
  '교재·물류·배송',
]

// 스택 바 범례에 어떤 소분류만 집계됐는지 표시
// 보고서 수신자 눈높이 범례 — 대분류/소분류 용어 대신 실제 내용으로 표기
const RISK_DISPLAY_LABEL: Record<string, string> = {
  '네트워크·앱 오류':   '네트워크·앱 오류',
  '기기·하드웨어 오류':  '기기·하드웨어 오류',
  '미납·결제':        '미납 관리',
  '해지·유지 상담':    '해지 확정 · 해지금·위약금 문의',
  '교재·물류·배송':    '기기 장기미회수 · 누락·오배송',
}

// 카테고리 공유 팔레트 — 도넛과 리스크 스택 바가 같은 색 사용
const PALETTE = [
  '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#64748b',
]

// category_breakdown (내림차순 정렬 기준)에서 카테고리 위치를 찾아 팔레트 색 반환
function getCatColor(main: string, breakdown: { main: string }[]): string {
  const idx = breakdown.findIndex(c => c.main === main)
  return PALETTE[idx >= 0 ? idx % PALETTE.length : PALETTE.length - 1]
}

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

function KpiCard({
  label, value, unit, color, sub,
}: { label: string; value: string; unit: string; color: string; sub?: string }) {
  return (
    <div style={{
      background: '#fff', borderRadius: 14, padding: '20px 24px',
      boxShadow: '0 1px 6px rgba(0,0,0,.07)', borderTop: `4px solid ${color}`,
    }}>
      <div style={{
        fontSize: 22, fontWeight: 700, color: '#94a3b8',
        textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 10,
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 38, fontWeight: 800, color, lineHeight: 1 }}>{value}</span>
        <span style={{ fontSize: 17, color: '#64748b', fontWeight: 600 }}>{unit}</span>
      </div>
      {sub && <div style={{ fontSize: 13, color: '#64748b', marginTop: 6, fontWeight: 600 }}>{sub}</div>}
    </div>
  )
}

// ── 일별 건수 바 (HTML) ────────────────────────────────────────────────────────

function DailyBar({ dailyCounts }: { dailyCounts: WeeklyDayCount[] }) {
  const max = Math.max(...dailyCounts.map(d => d.count), 1)
  const BAR_MAX_H = 144

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: BAR_MAX_H + 48 }}>
      {dailyCounts.map((d) => {
        const h = Math.max(Math.round((d.count / max) * BAR_MAX_H), d.count > 0 ? 3 : 0)
        return (
          <div
            key={d.date}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end' }}
          >
            <span style={{ fontSize: 12, color: d.is_weekend ? WEEKEND_GREY : '#3b82f6', fontWeight: 700, marginBottom: 2 }}>{d.count}</span>
            <div style={{
              width: '100%', height: h, borderRadius: '3px 3px 0 0',
              background: d.is_weekend ? WEEKEND_GREY : 'linear-gradient(180deg, #60a5fa, #3b82f6)',
            }} />
            <div style={{ fontSize: 12, color: d.is_weekend ? '#94a3b8' : '#475569', fontWeight: 500, marginTop: 3 }}>
              {fmtDate(d.date)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Ollama 단건 테스트 패널 ───────────────────────────────────────────────────

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
      <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10 }}>Ollama 단건 테스트</div>
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

  type MemoState = { open: boolean; page: number; data: WeeklyMemosPage | null; loading: boolean }
  const [memoStates, setMemoStates] = useState<Record<string, MemoState>>({})

  // Chart.js 캔버스 및 인스턴스
  const sqiRef      = useRef<HTMLCanvasElement>(null)
  const donutRef    = useRef<HTMLCanvasElement>(null)
  const stackRef    = useRef<HTMLCanvasElement>(null)
  const sqiChart    = useRef<Chart | null>(null)
  const donutChart  = useRef<Chart | null>(null)
  const stackChart  = useRef<Chart | null>(null)

  useEffect(() => {
    loadReport()
  }, [weekStart])

  // 언마운트 시 차트 정리
  useEffect(() => () => {
    sqiChart.current?.destroy()
    donutChart.current?.destroy()
    stackChart.current?.destroy()
  }, [])

  // 보고서 변경 시 차트 재생성
  useEffect(() => {
    if (!report) {
      sqiChart.current?.destroy()
      donutChart.current?.destroy()
      stackChart.current?.destroy()
      return
    }
    renderSqiChart(report)
    renderDonutChart(report)
    renderStackChart(report)
  }, [report])

  async function loadMemos(main: string, page: number) {
    setMemoStates(s => ({ ...s, [main]: { ...(s[main] ?? { open: true, data: null }), open: true, page, loading: true } }))
    try {
      const data = await api.fetchWeeklyMemos(weekStart, main, page)
      setMemoStates(s => ({ ...s, [main]: { ...s[main], data, loading: false } }))
    } catch {
      setMemoStates(s => ({ ...s, [main]: { ...s[main], loading: false } }))
    }
  }

  function toggleMemos(main: string) {
    const cur = memoStates[main]
    if (cur?.open) {
      setMemoStates(s => ({ ...s, [main]: { ...s[main], open: false } }))
    } else {
      loadMemos(main, cur?.page ?? 1)
    }
  }

  async function loadReport() {
    setLoading(true)
    setReport(null)
    setNotFound(false)
    setMemoStates({})
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
      alert(`보고서 생성 실패: ${e}`)
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
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { callback: v => `${v}%` } },
          x: { grid: { display: false } },
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
          legend: {
            position: 'right',
            labels: {
              boxWidth: 11,
              font: { size: 11 },
              generateLabels: (chart: Chart) => {
                const ds = chart.data.datasets[0]
                const vals = ds.data as number[]
                return (chart.data.labels as string[]).map((label, i) => ({
                  text: `${label}  ${vals[i].toLocaleString()}건`,
                  fillStyle: (ds.backgroundColor as string[])[i],
                  strokeStyle: '#fff',
                  lineWidth: 2,
                  index: i,
                  hidden: false,
                }))
              },
            },
          },
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
      } as any,
    })
  }

  function renderStackChart(r: WeeklyReportType) {
    if (!stackRef.current || r.risk_stack.length === 0) return
    stackChart.current?.destroy()
    const presentMains = RISK_MAINS.filter(main =>
      r.risk_stack.some(d => (d[main] as number | undefined ?? 0) > 0)
    )
    stackChart.current = new Chart(stackRef.current, {
      type: 'bar',
      data: {
        labels: r.risk_stack.map(d => fmtDate(d.date)),
        datasets: presentMains.map(main => ({
          label: RISK_DISPLAY_LABEL[main] ?? main,
          data: r.risk_stack.map(d => (d[main] as number | undefined) ?? 0),
          backgroundColor: getCatColor(main, r.category_breakdown),
          borderRadius: 2,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
        },
        scales: {
          y: { stacked: true, beginAtZero: true },
          x: { stacked: true, grid: { display: false } },
        },
      },
    })
  }

  const weekEnd = addDays(weekStart, 6)
  const riskPct = report && report.total_weekday > 0
    ? (report.risk_total / report.total_weekday * 100).toFixed(1)
    : '0.0'

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
          <div className="loading">불러오는 중...</div>
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
              "보고서 생성" 버튼을 클릭해 Ollama 분석을 시작하세요.
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

          {/* KPI 4개 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 14, marginBottom: 16 }}>
            <KpiCard label="총 상담" value={report.total_weekday.toLocaleString()} unit="건" color={NAVY} sub="평일 기준" />
            <KpiCard label="일 평균" value={report.daily_avg.toLocaleString()} unit="건/일" color={NAVY2} />
            <KpiCard label="리스크 CS" value={report.risk_total.toLocaleString()} unit="건" color={RISK_RED} />
            <KpiCard
              label="리스크율"
              value={riskPct}
              unit="%"
              color={Number(riskPct) > 20 ? RISK_RED : '#4f46e5'}
              sub="전체 상담 중 위험 유형 비중"
            />
          </div>

          {/* 일별 건수 + SQI */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div className="section-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <div style={{ fontSize: 21, fontWeight: 700, color: NAVY }}>일별 CS 건수</div>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>평일은 파란색, 주말은 회색으로 표시합니다</span>
              </div>
              <DailyBar dailyCounts={report.daily_counts} />
            </div>
            <div className="section-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <div style={{ fontSize: 21, fontWeight: 700, color: NAVY }}>리스크율 추이</div>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>주 평균 기준선을 초과한 날은 빨간 점으로 표시합니다</span>
              </div>
              <div style={{ height: 192, position: 'relative' }}>
                {report.sqi_daily.length === 0
                  ? <div style={{ fontSize: 13, color: '#94a3b8', paddingTop: 60, textAlign: 'center' }}>데이터 없음</div>
                  : <canvas ref={sqiRef} />
                }
              </div>
            </div>
          </div>

          {/* 도넛 (전체 폭) */}
          <div className="section-card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{ fontSize: 21, fontWeight: 700, color: NAVY }}>이번 주 CS 유형 분포</div>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>전체 상담을 문의 유형별로 나눈 비중입니다</span>
            </div>
            <div style={{ height: 264, position: 'relative' }}>
              <canvas ref={donutRef} />
            </div>
          </div>

          {/* 리스크 카테고리 일별 추이 + AI 분석 */}
          <div className="section-card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{ fontSize: 21, fontWeight: 700, color: NAVY }}>리스크 카테고리 일별 추이</div>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>해지·결제·오류 등 위험 유형이 요일별로 얼마나 발생했는지 보여줍니다</span>
            </div>
            <div style={{ height: 264, position: 'relative' }}>
              {report.risk_stack.length === 0
                ? <div style={{ fontSize: 13, color: '#94a3b8', paddingTop: 80, textAlign: 'center' }}>데이터 없음</div>
                : <canvas ref={stackRef} />
              }
            </div>
            {report.risk_rows.length > 0 && (
              <div style={{ marginTop: 24, borderTop: '1px solid #f1f5f9', paddingTop: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                  <h3 style={{ margin: 0, color: NAVY, fontSize: 22 }}>리스크 카테고리별 AI 분석</h3>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>각 위험 유형에서 이번 주 두드러진 패턴을 AI가 분석합니다</span>
                </div>
                {report.risk_rows.map((row, i) => {
                  const ms = memoStates[row.main]
                  const totalPages = ms?.data ? Math.ceil(ms.data.total / ms.data.page_size) : 1
                  return (
                    <div key={row.main} style={{
                      borderBottom: i < report.risk_rows.length - 1 ? '1px solid #f1f5f9' : 'none',
                      paddingBottom: 16, marginBottom: 16,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                        <span style={{ fontWeight: 700, fontSize: 15, color: '#1e293b' }}>
                          {RISK_DISPLAY_LABEL[row.main] ?? row.main}
                        </span>
                        <span style={{
                          fontSize: 12, fontWeight: 700, color: RISK_RED,
                          background: '#fef2f2', borderRadius: 6,
                          padding: '2px 8px', border: '1px solid #fecaca',
                        }}>
                          {row.count}건
                        </span>
                      </div>
                      {row.summary
                        ? <div style={{
                            fontSize: 13, color: '#374151', lineHeight: 1.7,
                            background: '#f0f4fb', borderRadius: 6,
                            padding: '7px 12px', borderLeft: `3px solid ${NAVY}`,
                            margin: '0 0 10px', whiteSpace: 'pre-line',
                          }}>{row.summary}</div>
                        : <p style={{ margin: '0 0 10px', fontSize: 13, lineHeight: 1.7 }}>
                            {aiGenerating
                              ? <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>AI 분석 중...</span>
                              : <span style={{ color: '#94a3b8' }}>(분석 없음)</span>
                            }
                          </p>
                      }
                      {/* 메모 토글 */}
                      <button
                        onClick={() => toggleMemos(row.main)}
                        style={{
                          fontSize: 11, color: '#64748b', background: 'none',
                          border: '1px solid #e2e8f0', borderRadius: 5,
                          padding: '3px 10px', cursor: 'pointer',
                        }}
                      >
                        {ms?.open ? '메모 접기 ▴' : '메모 보기 ▾'}
                      </button>
                      {ms?.open && (
                        <div style={{ marginTop: 10 }}>
                          {ms.loading
                            ? <div style={{ fontSize: 12, color: '#94a3b8', padding: '8px 0' }}>불러오는 중...</div>
                            : ms.data && ms.data.memos.length > 0
                              ? <>
                                  {ms.data.memos.map((m, mi) => (
                                    <div key={mi} style={{
                                      display: 'flex', gap: 8, alignItems: 'baseline',
                                      padding: '5px 0', borderBottom: '1px solid #f8fafc',
                                      fontSize: 12,
                                    }}>
                                      <span style={{ color: '#94a3b8', whiteSpace: 'nowrap', minWidth: 70 }}>{fmtDate(m.date)}</span>
                                      <span style={{
                                        color: '#475569', background: '#f1f5f9',
                                        borderRadius: 4, padding: '1px 6px',
                                        whiteSpace: 'nowrap', fontSize: 11,
                                      }}>{m.sub}</span>
                                      <span style={{ color: '#374151', lineHeight: 1.5 }}>
                                        {m.text.length > 120 ? m.text.slice(0, 120) + '…' : m.text}
                                      </span>
                                    </div>
                                  ))}
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12, color: '#64748b' }}>
                                    <button
                                      disabled={ms.page <= 1}
                                      onClick={() => loadMemos(row.main, ms.page - 1)}
                                      style={{ border: '1px solid #e2e8f0', borderRadius: 4, padding: '2px 8px', background: '#fff', cursor: ms.page <= 1 ? 'default' : 'pointer', color: ms.page <= 1 ? '#cbd5e1' : '#374151' }}
                                    >이전</button>
                                    <span>{ms.page} / {totalPages} 페이지 (총 {ms.data.total}건)</span>
                                    <button
                                      disabled={ms.page >= totalPages}
                                      onClick={() => loadMemos(row.main, ms.page + 1)}
                                      style={{ border: '1px solid #e2e8f0', borderRadius: 4, padding: '2px 8px', background: '#fff', cursor: ms.page >= totalPages ? 'default' : 'pointer', color: ms.page >= totalPages ? '#cbd5e1' : '#374151' }}
                                    >다음</button>
                                  </div>
                                </>
                              : <div style={{ fontSize: 12, color: '#94a3b8', padding: '8px 0' }}>메모 없음</div>
                          }
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 주간 종합 분석 (전체 폭) */}
          <div className="section-card">
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #f1f5f9',
            }}>
              <h3 style={{ margin: 0, color: NAVY, fontSize: 22 }}>이번 주 CS 종합 브리핑</h3>
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
                : <div style={{ fontSize: 13, color: '#94a3b8' }}>(분석 없음)</div>
            }
          </div>

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
        </>
      )}
    </div>
  )
}
