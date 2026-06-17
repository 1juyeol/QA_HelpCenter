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
  type WeeklyPeakDay,
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
const WEEKDAYS_KO = ['월', '화', '수', '목', '금']

// ── 유틸 ──────────────────────────────────────────────────────────────────────

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
        fontSize: 11, fontWeight: 700, color: '#94a3b8',
        textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 10,
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 32, fontWeight: 800, color, lineHeight: 1 }}>{value}</span>
        <span style={{ fontSize: 14, color: '#94a3b8', fontWeight: 600 }}>{unit}</span>
      </div>
      {sub && <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 6 }}>{sub}</div>}
    </div>
  )
}

// ── 일별 건수 바 (HTML) ────────────────────────────────────────────────────────

function DailyBar({ dailyCounts }: { dailyCounts: WeeklyDayCount[] }) {
  const max = Math.max(...dailyCounts.map(d => d.count), 1)
  const BAR_MAX_H = 80

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: BAR_MAX_H + 48 }}>
      {dailyCounts.map((d, i) => {
        const h = Math.max(Math.round((d.count / max) * BAR_MAX_H), d.count > 0 ? 3 : 0)
        const color = d.is_weekend ? WEEKEND_GREY : NAVY
        return (
          <div
            key={d.date}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end' }}
          >
            <span style={{ fontSize: 10, color, fontWeight: 700, marginBottom: 2 }}>{d.count}</span>
            <div style={{
              width: '100%', height: h, borderRadius: '3px 3px 0 0',
              background: d.is_weekend ? WEEKEND_GREY : `linear-gradient(180deg, ${NAVY}, ${NAVY2})`,
            }} />
            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 3 }}>
              {d.date.slice(5).replace('-', '/')}
            </div>
            <div style={{ fontSize: 10, color: d.is_weekend ? '#94a3b8' : '#475569', fontWeight: 600 }}>
              ({DAYS_KO[i]})
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── 피크타임 바 (HTML) ────────────────────────────────────────────────────────

function PeakBar({ peakDaily }: { peakDaily: WeeklyPeakDay[] }) {
  const max = Math.max(...peakDaily.map(d => d.count), 1)
  const BAR_MAX_H = 80

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: BAR_MAX_H + 48 }}>
      {peakDaily.map((d, i) => {
        const h = Math.max(Math.round((d.count / max) * BAR_MAX_H), d.count > 0 ? 3 : 0)
        const isMax = d.count > 0 && d.count === max
        return (
          <div
            key={d.date}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end' }}
          >
            <span style={{ fontSize: 10, color: isMax ? RISK_RED : NAVY, fontWeight: isMax ? 800 : 600, marginBottom: 2 }}>
              {d.count}
            </span>
            <div style={{
              width: '100%', height: h, borderRadius: '3px 3px 0 0',
              background: isMax
                ? `linear-gradient(180deg, ${RISK_RED}, #f87171)`
                : `linear-gradient(180deg, ${NAVY}, ${NAVY2})`,
            }} />
            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 3 }}>
              {d.date.slice(5).replace('-', '/')}
            </div>
            <div style={{ fontSize: 10, color: '#475569', fontWeight: 600 }}>
              ({WEEKDAYS_KO[i]})
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── AI 분석 뱃지 ──────────────────────────────────────────────────────────────

function AiBadge() {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, color: NAVY,
      background: '#dbeafe', borderRadius: 4,
      padding: '1px 6px', letterSpacing: '0.03em',
    }}>AI 분석</span>
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
      alert(`보고서 생성 실패: ${e}`)
      setGenerating(false)
    } finally {
      setAiGenerating(false)
    }
  }

  function renderSqiChart(r: WeeklyReportType) {
    if (!sqiRef.current || r.sqi_daily.length === 0) return
    sqiChart.current?.destroy()
    const avg = r.sqi_daily.reduce((s, p) => s + p.sqi, 0) / r.sqi_daily.length
    const baseline = Math.round(avg * 10) / 10
    sqiChart.current = new Chart(sqiRef.current, {
      type: 'line',
      data: {
        labels: r.sqi_daily.map(p => p.date.slice(5).replace('-', '/')),
        datasets: [
          {
            data: r.sqi_daily.map(p => p.sqi),
            borderColor: NAVY,
            backgroundColor: 'rgba(30,60,114,0.07)',
            pointBackgroundColor: r.sqi_daily.map(p => p.sqi > baseline ? RISK_RED : NAVY),
            pointRadius: 5,
            tension: 0.3,
            fill: true,
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
      options: {
        cutout: '58%',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 11, font: { size: 11 } } },
        },
      },
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
        labels: r.risk_stack.map(d => d.date.slice(5).replace('-', '/')),
        datasets: presentMains.map(main => ({
          label: main,
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
            <div style={{ fontSize: 12, opacity: 0.55, marginTop: 4 }}>
              생성: {report.generated_at}
            </div>
          </div>

          {/* KPI 4개 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 14, marginBottom: 16 }}>
            <KpiCard label="총 상담" value={report.total_weekday.toLocaleString()} unit="건" color={NAVY} sub="평일 기준" />
            <KpiCard label="일 평균" value={report.daily_avg.toLocaleString()} unit="건/일" color={NAVY2} />
            <KpiCard label="리스크 CS" value={report.risk_total.toLocaleString()} unit="건" color={RISK_RED} sub={`전체의 ${riskPct}%`} />
            <KpiCard
              label="SQI"
              value={`${report.week_sqi}`}
              unit="%"
              color={report.week_sqi > 20 ? RISK_RED : '#4f46e5'}
              sub="주 평균"
            />
          </div>

          {/* 일별 건수 + SQI */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div className="section-card">
              <div style={{ fontSize: 14, fontWeight: 700, color: NAVY, marginBottom: 4 }}>일별 CS 건수</div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>주말은 회색 표시</div>
              <DailyBar dailyCounts={report.daily_counts} />
            </div>
            <div className="section-card">
              <div style={{ fontSize: 14, fontWeight: 700, color: NAVY, marginBottom: 4 }}>SQI 추이</div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>기준선(주 평균) 초과일은 빨간 점</div>
              <div style={{ height: 160, position: 'relative' }}>
                {report.sqi_daily.length === 0
                  ? <div style={{ fontSize: 13, color: '#94a3b8', paddingTop: 60, textAlign: 'center' }}>데이터 없음</div>
                  : <canvas ref={sqiRef} />
                }
              </div>
            </div>
          </div>

          {/* 카테고리 도넛 + 리스크 스택 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div className="section-card">
              <div style={{ fontSize: 14, fontWeight: 700, color: NAVY, marginBottom: 16 }}>전체 카테고리 비율</div>
              <div style={{ height: 220, position: 'relative' }}>
                <canvas ref={donutRef} />
              </div>
            </div>
            <div className="section-card">
              <div style={{ fontSize: 14, fontWeight: 700, color: NAVY, marginBottom: 4 }}>리스크 카테고리 일별</div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>평일 기준 스택 바</div>
              <div style={{ height: 220, position: 'relative' }}>
                {report.risk_stack.length === 0
                  ? <div style={{ fontSize: 13, color: '#94a3b8', paddingTop: 80, textAlign: 'center' }}>데이터 없음</div>
                  : <canvas ref={stackRef} />
                }
              </div>
            </div>
          </div>

          {/* 리스크 AI 분석 */}
          {report.risk_rows.length > 0 && (
            <div className="section-card" style={{ marginBottom: 14 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid #f1f5f9',
              }}>
                <h3 style={{ margin: 0, color: NAVY, fontSize: 15 }}>리스크 카테고리별 AI 분석</h3>
                <AiBadge />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                {report.risk_rows.map(row => (
                  <div key={row.main} style={{
                    border: `1px solid ${getCatColor(row.main, report.category_breakdown)}30`,
                    borderLeft: `4px solid ${getCatColor(row.main, report.category_breakdown)}`,
                    borderRadius: 8, padding: '12px 14px',
                    background: '#fafbff',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: getCatColor(row.main, report.category_breakdown) }}>
                        {row.main}
                      </span>
                      <span style={{
                        fontSize: 11, fontWeight: 700, color: RISK_RED,
                        background: '#fef2f2', borderRadius: 6,
                        padding: '2px 7px', border: '1px solid #fecaca',
                      }}>
                        {row.count}건
                      </span>
                    </div>
                    <p style={{ margin: 0, fontSize: 12, color: '#374151', lineHeight: 1.65 }}>
                      {row.summary
                        ? row.summary
                        : aiGenerating
                          ? <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>AI 분석 중...</span>
                          : <span style={{ color: '#94a3b8' }}>(분석 없음)</span>
                      }
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 피크타임 + 주간 종합 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div className="section-card">
              <div style={{ fontSize: 14, fontWeight: 700, color: NAVY, marginBottom: 4 }}>피크타임 요일별 건수</div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>17~20:30 KST · 최다 요일 강조</div>
              {report.peak_daily.length > 0
                ? <PeakBar peakDaily={report.peak_daily} />
                : <div style={{ fontSize: 13, color: '#94a3b8' }}>데이터 없음</div>
              }
            </div>
            <div className="section-card">
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #f1f5f9',
              }}>
                <h3 style={{ margin: 0, color: NAVY, fontSize: 15 }}>주간 종합 분석</h3>
                <AiBadge />
              </div>
              {report.weekly_summary
                ? (
                  <div style={{
                    fontSize: 13, color: '#374151', lineHeight: 1.7,
                    background: '#f0f4fb', borderRadius: 6,
                    padding: '10px 14px', borderLeft: `3px solid ${NAVY}`,
                  }}>
                    {report.weekly_summary}
                  </div>
                )
                : aiGenerating
                  ? <div style={{ fontSize: 13, color: '#94a3b8', fontStyle: 'italic' }}>AI 분석 중...</div>
                  : <div style={{ fontSize: 13, color: '#94a3b8' }}>(분석 없음)</div>
              }
            </div>
          </div>
        </>
      )}
    </div>
  )
}
