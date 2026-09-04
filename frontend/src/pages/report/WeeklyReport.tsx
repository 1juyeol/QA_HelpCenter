// 주간 CS 보고서 페이지. 선택한 주(월~일)의 CS 통계를 종합적으로 보여준다.
//
// 레이아웃 (위→아래):
//   1. 컨트롤바 — 주차 선택(드롭다운) + 보고서 생성 버튼
//   2. 그라디언트 헤더 배너 (주 범위 표시)
//   3. KPI 카드 4개 — 총상담(7일 전체) / 일평균·리스크 상담·SQI(영업일 기준)
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

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import Chart from 'chart.js/auto'
import {
  api,
  adminStudentUrl, adminParentUrl,
  type WeeklyReport as WeeklyReportType,
  type WeeklyDayCount,
  type InsightWings,
} from '../../api/client'
import CategoryMemoModal from '../../components/CategoryMemoModal'
import { useAdmin } from '../../hooks/useAdmin'

const NAVY = '#1e3c72'
const NAVY2 = '#2a5298'
const RISK_RED = '#ef4444'
const AMBER = '#f59e0b'
const PURPLE = '#8b5cf6'

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
  if (delta === 0) return <div style={{ fontSize: 16, color: '#94a3b8', marginTop: 5 }}>전주 동일</div>
  const isPositive = delta > 0
  const color = invert
    ? (isPositive ? '#ef4444' : '#16a34a')
    : '#f59e0b'
  const arrow = isPositive ? '↑' : '↓'
  return (
    <div style={{ fontSize: 18, color, fontWeight: 600, marginTop: 5 }}>
      {arrow} {isPositive ? '+' : ''}{delta.toLocaleString()}{unit}
      {deltaPct != null && <span style={{ fontSize: 14, fontWeight: 500, marginLeft: 3 }}>({isPositive ? '+' : ''}{deltaPct.toLocaleString()}%)</span>}
      <span style={{ fontSize: 14, color: '#94a3b8', fontWeight: 400, marginLeft: 4 }}>전주 대비</span>
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
          legend: { position: 'top', labels: { boxWidth: 10, font: { size: 17 }, padding: 14 } },
        },
        scales: {
          y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { font: { size: 13 }, padding: 10 } },
          x: {
            grid: { display: false },
            ticks: {
              padding: 10,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              font: (ctx: any) => {
                const isThisWeek = ctx.index >= prevData.length
                return { size: isThisWeek ? 16 : 13, weight: isThisWeek ? 'bold' : 'normal' }
              },
            },
          },
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

// Wings 티켓 관리상태 종료값. WingsTickets.tsx의 CLOSED_STATES와 같은 기준이다 — 페이지 간
// 직접 참조는 하지 않는다는 원칙(정책 8)에 따라 이 파일 안에 똑같이 둔다.
const WINGS_CLOSED_STATES = new Set(['해결', '요청취소', 'merged'])

function wingsDiffDays(r: InsightWings): number {
  if (!r.first_date) return 0
  return Math.floor((Date.now() - new Date(r.first_date).getTime()) / 86400000)
}

type SeverityBucket = 'under7' | 'between' | 'over30'

function severityBucketOf(r: InsightWings): SeverityBucket {
  const d = wingsDiffDays(r)
  if (d >= 30) return 'over30'
  if (d >= 7) return 'between'
  return 'under7'
}

const SEVERITY_SEGMENTS: { key: SeverityBucket; label: string; color: string }[] = [
  { key: 'under7', label: '7일 미만', color: '#10b981' },
  { key: 'between', label: '7~29일', color: AMBER },
  { key: 'over30', label: '30일 이상', color: RISK_RED },
]

// 장기미해결 상담 현황의 4개 카드(미해결 티켓/2회 이상 상담/7일+/30일+)는 서로 부분집합이라
// 시계열보다 구성비가 더 잘 읽힌다 — 미해결 티켓 총량을 겹치지 않는 3구간(7일 미만/7~29일/
// 30일 이상)으로 재구성해 막대 하나로 보여준다. Chart.js 없이 순수 HTML/CSS로 그린다 —
// 세그먼트 3개짜리 막대 하나에 캔버스까지 쓸 필요는 없다("가벼운 그래프" 요청 취지).
// 막대 너비는 이 보고서가 생성된 시점의 스냅샷 값(report.wings_*)을 그대로 쓰지만, 세그먼트
// 클릭 시 뜨는 모달은 반복 Wings 티켓 페이지와 같은 API(/api/insights/wings_tickets)로 지금
// 조회한 살아있는 목록을 그 자리에서 같은 기준(7일/30일 경과)으로 나눠 보여준다 — 과거 주의
// 정확한 티켓별 스냅샷은 저장해둔 적이 없어서(위쪽 카드 값과 달리) 목록 자체는 "현재 기준"일
// 수밖에 없다. 모달 안에 그 사실을 명시한다.
function UnresolvedSeverityBar({
  total, delayed7, delayed30, onSegmentClick,
}: {
  total: number; delayed7: number; delayed30: number
  onSegmentClick: (bucket: SeverityBucket) => void
}) {
  if (total <= 0) return null
  const under7 = Math.max(total - delayed7, 0)
  const between = Math.max(delayed7 - delayed30, 0)
  const over30 = Math.max(delayed30, 0)
  const counts: Record<SeverityBucket, number> = { under7, between, over30 }
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', height: 22, borderRadius: 6, overflow: 'hidden' }}>
        {SEVERITY_SEGMENTS.map(s => counts[s.key] > 0 && (
          <div
            key={s.key}
            onClick={() => onSegmentClick(s.key)}
            style={{ width: `${counts[s.key] / total * 100}%`, background: s.color, cursor: 'pointer' }}
            title={`${s.label}: ${counts[s.key]}건 — 클릭하면 목록 확인`}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 18, marginTop: 8, flexWrap: 'wrap' }}>
        {SEVERITY_SEGMENTS.map(s => (
          <span
            key={s.key}
            onClick={() => counts[s.key] > 0 && onSegmentClick(s.key)}
            style={{ fontSize: 15, color: '#374151', cursor: counts[s.key] > 0 ? 'pointer' : 'default' }}
          >
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: s.color, marginRight: 5 }} />
            {s.label} {counts[s.key].toLocaleString()}건 ({Math.round(counts[s.key] / total * 100)}%)
          </span>
        ))}
      </div>
    </div>
  )
}

const SEVERITY_MODAL_PAGE_SIZE = 50

function SeverityListModal({ bucket, rows, onClose }: { bucket: SeverityBucket; rows: InsightWings[]; onClose: () => void }) {
  const label = SEVERITY_SEGMENTS.find(s => s.key === bucket)!.label
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(rows.length / SEVERITY_MODAL_PAGE_SIZE))
  const pagedRows = rows.slice((page - 1) * SEVERITY_MODAL_PAGE_SIZE, page * SEVERITY_MODAL_PAGE_SIZE)

  // CategoryMemoModal(다른 모달들)과 같은 페이지네이션 UI — 50건씩.
  const pager = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#64748b' }}>
      <button
        disabled={page <= 1}
        onClick={() => setPage(p => p - 1)}
        style={{
          border: '1px solid #e2e8f0', borderRadius: 6, padding: '4px 14px',
          background: '#fff', fontSize: 13,
          cursor: page <= 1 ? 'default' : 'pointer',
          color: page <= 1 ? '#cbd5e1' : '#374151',
        }}
      >이전</button>
      <span>{page} / {totalPages} 페이지 (총 {rows.length.toLocaleString()}건)</span>
      <button
        disabled={page >= totalPages}
        onClick={() => setPage(p => p + 1)}
        style={{
          border: '1px solid #e2e8f0', borderRadius: 6, padding: '4px 14px',
          background: '#fff', fontSize: 13,
          cursor: page >= totalPages ? 'default' : 'pointer',
          color: page >= totalPages ? '#cbd5e1' : '#374151',
        }}
      >다음</button>
    </div>
  )

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#fff', borderRadius: 16,
        width: '100%', maxWidth: 1040, maxHeight: '90vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '18px 32px', borderBottom: '1px solid #e2e8f0',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#1e293b' }}>경과일 {label}</div>
            <div style={{ marginTop: 4, fontSize: 15, color: '#475569', fontWeight: 500 }}>
              현재 시점 기준 목록 · 총 {rows.length}건
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#94a3b8', lineHeight: 1, padding: 4 }}
          >✕</button>
        </div>
        <div style={{ padding: '10px 32px', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
          {pager}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px' }}>
          {/* 가로 스크롤 없이 한 화면에 들어오도록 tableLayout:fixed + 컬럼별 고정폭(반복 Wings
              티켓 페이지 표와 같은 방식) — 나머지 폭은 전부 최근 메모 컬럼에 준다. */}
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
              <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                {[
                  ['티켓 번호', 85], ['학생번호', 70], ['학부모번호', 70], ['카테고리', 110],
                  ['상담 건수', 70], ['경과일', 50], ['관리상태', 90], ['최근 메모', undefined],
                ].map(([h, w]) => (
                  <th key={h as string} style={{ width: w, padding: '10px 12px', textAlign: 'left', fontSize: 16, fontWeight: 700, color: '#64748b' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pagedRows.map(r => (
                <tr key={r.ticket_id} style={{ borderBottom: '1px solid #f8fafc' }}>
                  <td style={{ padding: '9px 12px', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                    <a href={`https://wings.danbiedu.co.kr/#ticket/zoom/${r.ticket_id}`} target="_blank" rel="noreferrer" style={{ color: '#1a56db', fontWeight: 600, textDecoration: 'none' }}>
                      #{r.ticket_id}
                    </a>
                  </td>
                  <td style={{ padding: '9px 12px', fontSize: 15, verticalAlign: 'top' }}>
                    {r.student_id
                      ? <a href={adminStudentUrl(r.student_id)} target="_blank" rel="noreferrer" style={{ color: '#1a56db', textDecoration: 'none' }}>{r.student_id}</a>
                      : <span style={{ color: '#374151' }}>—</span>}
                  </td>
                  <td style={{ padding: '9px 12px', fontSize: 15, verticalAlign: 'top' }}>
                    {r.parent_id
                      ? <a href={adminParentUrl(String(r.parent_id))} target="_blank" rel="noreferrer" style={{ color: '#1a56db', textDecoration: 'none' }}>{r.parent_id}</a>
                      : <span style={{ color: '#374151' }}>—</span>}
                  </td>
                  <td style={{ padding: '9px 12px', fontSize: 15, verticalAlign: 'top', color: '#374151' }}>{r.category ?? '미분류'}</td>
                  <td style={{ padding: '9px 12px', fontSize: 15, verticalAlign: 'top' }}>{r.cs_count}건</td>
                  <td style={{ padding: '9px 12px', fontSize: 15, verticalAlign: 'top', whiteSpace: 'nowrap' }}>{wingsDiffDays(r)}일</td>
                  <td style={{ padding: '9px 12px', fontSize: 15, verticalAlign: 'top', color: '#374151' }}>{r.state ?? '조회 안됨'}</td>
                  <td style={{ padding: '9px 12px', fontSize: 15, color: '#374151', lineHeight: 1.6, verticalAlign: 'top', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                    {r.memos?.[0]?.memo
                      ? r.memos[0].memo.split('\n').map((line, i) => <span key={i}>{i > 0 && <br />}{line}</span>)
                      : <span style={{ color: '#cbd5e1' }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '12px 32px', borderTop: '1px solid #f1f5f9', flexShrink: 0 }}>
          {pager}
        </div>
      </div>
    </div>
  )
}

// DailyReport.tsx의 KpiCard와 크기·정렬 방식을 동일하게 맞춘 것 — 두 보고서 KPI 카드가
// 서로 다른 폰트 크기·정렬(baseline vs flex-end)을 쓰면 같은 화면 안에서 secondary/일반
// 카드 사이 숫자 위치가 어긋난다. flex-end + 고정 height로 폰트 크기가 달라도 숫자 밑선이
// 맞는다.
function KpiCard({
  label, value, unit, color, delta, deltaUnit, deltaInvert, deltaPct, isSecondary,
}: {
  label: string; value: string; unit: string; color: string
  delta?: number | null; deltaUnit?: string; deltaInvert?: boolean; deltaPct?: number | null; isSecondary?: boolean
}) {
  return (
    <div style={{
      background: '#fff', borderRadius: 14,
      padding: isSecondary ? '22px 20px 16px' : '22px 26px',
      boxShadow: isSecondary ? '0 1px 4px rgba(0,0,0,.06)' : '0 2px 10px rgba(0,0,0,.09)',
      borderTop: `${isSecondary ? 3 : 5}px solid ${color}`,
    }}>
      <div style={{
        fontSize: 17, fontWeight: 700, color: '#94a3b8',
        textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 8,
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 48 }}>
        <span style={{ fontSize: isSecondary ? 36 : 48, fontWeight: 800, color, lineHeight: 1 }}>{value}</span>
        <span style={{ fontSize: isSecondary ? 17 : 22, color: '#64748b', fontWeight: 600 }}>{unit}</span>
      </div>
      <DeltaBadge delta={delta} unit={deltaUnit ?? ''} invert={deltaInvert} deltaPct={deltaPct} />
    </div>
  )
}

// ── 일별 건수 바 (Chart.js) ───────────────────────────────────────────────────

// 일별 상담 건수(y축 "1,200"처럼 폭이 넓음)와 리스크 비율 추이(y축 "25%"처럼 폭이 좁음)를
// 나란히 두면, Chart.js가 y축 눈금 텍스트 폭에 맞춰 각자 다른 너비를 잡아서 두 차트의
// 그래프 시작 위치(가로축)가 어긋난다 — 두 차트 모두 y축 폭을 이 값으로 고정해서 맞춘다.
const SHARED_Y_AXIS_WIDTH = 54

// Chart.js는 y축(왼쪽) 눈금 텍스트를 기본적으로 축 선에 오른쪽 정렬해서 그린다 — "1,200"과
// "25%"처럼 자릿수가 다르면 끝나는 지점(축 선)은 같아도 시작 지점은 텍스트 길이만큼 달라
// 보인다. 왼쪽 정렬로 바꿔서 시작 지점을 맞춘다(끝나는 지점은 텍스트 길이에 따라 달라짐) —
// Chart.js 옵션에는 y축 눈금 텍스트 정렬을 뒤집는 기능이 없어서, 기본 눈금 렌더링은 끄고
// (ticks.display:false) 같은 위치에 왼쪽 정렬로 직접 그린다.
function leftAlignedYTicksPlugin(id: string) {
  return {
    id,
    afterDraw(chart: Chart) {
      const yScale = chart.scales.y
      if (!yScale) return
      const { ctx, chartArea } = chart
      const x = chartArea.left - SHARED_Y_AXIS_WIDTH + 6
      ctx.save()
      ctx.font = '13px Pretendard, sans-serif'
      ctx.fillStyle = (Chart.defaults.color as string) ?? '#666'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      yScale.ticks.forEach((tick: any, i: number) => {
        ctx.fillText(tick.label ?? '', x, yScale.getPixelForTick(i))
      })
      ctx.restore()
    },
  }
}

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

    // 최고치 막대만 16px 볼드 빨강으로 강조 — DailyReport.tsx 피크타임 차트의 강조 폰트
    // 크기(16px bold)와 맞춘 것. 나머지는 기존대로 11px.
    const datalabels = {
      id: 'datalabels',
      afterDatasetsDraw(chart: Chart) {
        const { ctx } = chart
        chart.data.datasets.forEach((_ds, di) => {
          chart.getDatasetMeta(di).data.forEach((bar, idx) => {
            const val = (chart.data.datasets[di].data[idx] as number)
            if (!val) return
            const isPeak = bgColors[idx] === '#ef4444'
            ctx.save()
            ctx.font = isPeak ? 'bold 16px Pretendard, sans-serif' : 'bold 11px Pretendard, sans-serif'
            ctx.fillStyle = isPeak ? '#ef4444' : '#374151'
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
        layout: { padding: { top: 36 } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => `${(ctx.raw as number).toLocaleString()}건` } },
        },
        scales: {
          y: {
            beginAtZero: true, grace: '10%', grid: { color: '#f1f5f9' }, ticks: { display: false, font: { size: 13 }, padding: 10 },
            afterFit: scale => { scale.width = SHARED_Y_AXIS_WIDTH },
          },
          x: { grid: { display: false }, ticks: { font: { size: 13 }, padding: 10 } },
        },
      },
      plugins: [datalabels, leftAlignedYTicksPlugin('dailyBarYTicks')],
    })

    return () => { chartRef.current?.destroy() }
  }, [dailyCounts])

  return <canvas ref={canvasRef} />
}

// ── 카테고리 AI 분석 패널 ──────────────────────────────────────────────────────

const WEEKLY_TEST_TARGETS = [...RISK_MAINS, '종합 브리핑']

function WeeklyTestPanel({
  weekStart,
  adminToken,
  onCategoryResult,
  onSummaryResult,
}: {
  weekStart: string
  adminToken: string
  onCategoryResult: (main: string, summary: string, gemmaError?: string | null) => void
  onSummaryResult: (summary: string, gemmaError?: string | null) => void
}) {
  const [target, setTarget] = useState(WEEKLY_TEST_TARGETS[0])
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ label: string; summary: string; insufficient_data?: boolean; gemma_error?: string | null } | null>(null)
  const [error, setError] = useState('')

  async function run() {
    setRunning(true)
    setResult(null)
    setError('')
    try {
      if (target === '종합 브리핑') {
        const r = await api.analyzeWeeklySummary(weekStart, adminToken)
        setResult({ label: '종합 브리핑', summary: r.summary, gemma_error: r.gemma_error })
        onSummaryResult(r.summary, r.gemma_error)
      } else {
        const r = await api.analyzeWeeklyCategory(weekStart, target, adminToken)
        setResult({ label: target, summary: r.summary, insufficient_data: r.insufficient_data, gemma_error: r.gemma_error })
        onCategoryResult(target, r.summary, r.gemma_error)
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
            {result.gemma_error && <span style={{ color: '#ef4444', marginLeft: 8 }} title={result.gemma_error}>AI 분석 실패</span>}
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
  const { isAdmin, adminToken } = useAdmin()
  const mondays = getRecentMondays()
  const [searchParams] = useSearchParams()
  // 감사 로그의 "보고서 보기" 링크(?week_start=)로 들어온 경우 그 주를 바로 보여준다.
  const [weekStart, setWeekStart] = useState(() => searchParams.get('week_start') ?? mondays[1])   // 기본: 직전 주
  // 감사 로그의 "보고서 보기" 링크(?highlight=)로 들어온 경우 해당 카테고리/구간으로 스크롤한다.
  const [highlightTarget] = useState(() => searchParams.get('highlight'))
  const hasScrolledToHighlight = useRef(false)
  const [report, setReport] = useState<WeeklyReportType | null>(null)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [aiGenerating, setAiGenerating] = useState(false)
  const [notFound, setNotFound] = useState(false)
  // 장기미해결 상담 현황의 막대 세그먼트 클릭용 — 선택한 주와 무관하게 현재 살아있는 Wings
  // 티켓 목록을 한 번만 불러온다("반복 Wings 티켓" 페이지와 같은 API).
  const [wingsRows, setWingsRows] = useState<InsightWings[]>([])
  const [severityModal, setSeverityModal] = useState<SeverityBucket | null>(null)

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

  useEffect(() => {
    api.fetchWingsTickets().then(res => setWingsRows(res.data || [])).catch(() => setWingsRows([]))
  }, [])

  useEffect(() => {
    if (!highlightTarget || !report || hasScrolledToHighlight.current) return
    const targetId = highlightTarget === '__summary__' ? 'summary-section' : `risk-row-${highlightTarget}`
    const el = document.getElementById(targetId)
    if (!el) return
    hasScrolledToHighlight.current = true
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.style.outline = '3px solid #ef4444'
    el.style.outlineOffset = '2px'
    setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = '' }, 2500)
  }, [highlightTarget, report])

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
    if (!adminToken) return
    setGenerating(true)
    try {
      // 1단계: 통계만 생성 → 차트 바로 렌더링
      const statsData = await api.generateWeeklyReportStats(weekStart, adminToken)
      setReport(statsData)
      setNotFound(false)
      setGenerating(false)

      // 2단계: AI 분석 → 요약 채움
      setAiGenerating(true)
      const fullData = await api.generateWeeklyReport(weekStart, adminToken)
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

    // 주 평균(baseline) 초과 지점은 전부 16px 볼드 빨강으로 값을 표시 — DailyBar(일별 상담건수)의
    // 최고치 강조 폰트 크기(16px bold)와 맞춘 것. 점 크기·선 색 강조(주 평균 초과 시 빨강·확대)와는
    // 별개로, 숫자 자체도 몇 건이 얼마나 초과했는지 한눈에 보이게 한다.
    // 첫/마지막 지점처럼 플롯 영역 가장자리에 가까운 점은 중앙 정렬(textAlign:'center')한
    // 텍스트의 절반이 y축 눈금 영역이나 캔버스 밖으로 잘려나간다 — 실제로 그린 텍스트 폭을
    // 측정해서 플롯 영역(chartArea) 안에 들어오도록 x좌표를 clamp한다.
    const aboveBaselineLabel = {
      id: 'aboveBaselineLabel',
      afterDatasetsDraw(chart: Chart) {
        const meta = chart.getDatasetMeta(0)
        const { ctx, chartArea } = chart
        r.sqi_daily.forEach((p, i) => {
          if (p.sqi <= baseline) return
          const point = meta.data[i]
          if (!point) return
          ctx.save()
          ctx.font = 'bold 16px Pretendard, sans-serif'
          ctx.fillStyle = RISK_RED
          ctx.textBaseline = 'bottom'
          const label = `${p.sqi}%`
          const halfWidth = ctx.measureText(label).width / 2
          const x = Math.min(Math.max(point.x, chartArea.left + halfWidth), chartArea.right - halfWidth)
          ctx.textAlign = 'center'
          ctx.fillText(label, x, point.y - 12)
          ctx.restore()
        })
      },
    }

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
        layout: { padding: { top: 36 } },
        plugins: {
          legend: { display: false },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tooltip: { callbacks: { label: (ctx: any) => `${ctx.parsed.y}%` } },
        },
        scales: {
          y: {
            beginAtZero: true, grace: '10%', ticks: { display: false, callback: v => `${v}%`, font: { size: 13 }, padding: 10 },
            afterFit: scale => { scale.width = SHARED_Y_AXIS_WIDTH },
          },
          x: { grid: { display: false }, ticks: { font: { size: 13 }, padding: 10 } },
        },
      },
      plugins: [aboveBaselineLabel, leftAlignedYTicksPlugin('sqiYTicks')],
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

  // total_all(주말·공휴일 포함 총합)이 없는 옛 보고서는 total_weekday로 대신한다.
  const totalAll = report ? report.total_all ?? report.total_weekday : 0
  const prevTotalAll = report?.prev_total_all ?? report?.prev_total_weekday ?? null

  const totalDelta = prevTotalAll != null ? totalAll - prevTotalAll : null
  const dailyAvgDelta = report?.prev_daily_avg != null
    ? Math.round(report.daily_avg - report.prev_daily_avg)
    : null
  const riskDelta = report?.prev_risk_total != null
    ? report.risk_total - report.prev_risk_total
    : null
  const riskDeltaPct = report?.prev_risk_total && report.prev_risk_total > 0
    ? Math.round((report.risk_total - report.prev_risk_total) / report.prev_risk_total * 100)
    : null
  const prevRiskPct = report?.prev_risk_total != null && report?.prev_total_weekday != null
    ? report.prev_risk_total / Math.max(report.prev_total_weekday, 1) * 100
    : null
  const riskPctDelta = prevRiskPct != null
    ? Math.round((Number(riskPct) - prevRiskPct) * 10) / 10
    : null

  // weekday_count는 이 계산 방식이 추가되기 전에 저장된 보고서엔 없는 필드라, 없으면
  // daily_counts에서 주말 아닌 날 수를 세어 대신 쓴다(공휴일까지는 못 거르지만 없는 것보단 낫다).
  const weekdayCount = report?.weekday_count ?? (report ? report.daily_counts.filter(d => !d.is_weekend).length : 0)

  // wings 스냅샷은 insights_cache(현재 상태만 남는 캐시) 기반이라 지난주 값을 실시간
  // 재계산할 수 없다 — report_weekly.py가 지난주 생성 시점에 저장해둔 값을 그대로 내려준다.
  // 지난주 보고서가 없으면 prev_*가 null이라 delta도 null → 다른 KPI 카드와 똑같이 배지
  // 자체가 안 뜬다(DeltaBadge: delta==null → null 반환).
  const wingsUnresolvedDelta = report?.prev_wings_unresolved_count != null
    ? (report.wings_unresolved_count ?? 0) - report.prev_wings_unresolved_count
    : null
  const wingsRepeatDelta = report?.prev_wings_repeat_count != null
    ? (report.wings_repeat_count ?? 0) - report.prev_wings_repeat_count
    : null
  const wingsDelayed7Delta = report?.prev_wings_delayed_7_count != null
    ? (report.wings_delayed_7_count ?? 0) - report.prev_wings_delayed_7_count
    : null
  const wingsDelayed30Delta = report?.prev_wings_delayed_30_count != null
    ? (report.wings_delayed_30_count ?? 0) - report.prev_wings_delayed_30_count
    : null

  // 반복 상담 학부모 스냅샷도 wings와 같은 이유(캐시가 현재 상태만 남김)로 지난주 값을
  // report_weekly.py가 저장해둔 걸 그대로 받는다.
  const parentsTotalDelta = report?.prev_parents_total_count != null
    ? (report.parents_total_count ?? 0) - report.prev_parents_total_count
    : null
  const parentsRepeatDelta = report?.prev_parents_repeat_count != null
    ? (report.parents_repeat_count ?? 0) - report.prev_parents_repeat_count
    : null
  const parentsShortgapDelta = report?.prev_parents_shortgap_count != null
    ? (report.parents_shortgap_count ?? 0) - report.prev_parents_shortgap_count
    : null
  const parentsComplexDelta = report?.prev_parents_complex_count != null
    ? (report.parents_complex_count ?? 0) - report.prev_parents_complex_count
    : null

  // 미해결 Jira 이슈 스냅샷도 wings/학부모 반복 상담과 같은 이유로 지난주 값을
  // report_weekly.py가 저장해둔 걸 그대로 받는다.
  const jiraTotalDelta = report?.prev_jira_total_count != null
    ? (report.jira_total_count ?? 0) - report.prev_jira_total_count
    : null
  const jiraPendingReviewDelta = report?.prev_jira_pending_review_count != null
    ? (report.jira_pending_review_count ?? 0) - report.prev_jira_pending_review_count
    : null
  const jiraSixMonthDelta = report?.prev_jira_six_month_count != null
    ? (report.jira_six_month_count ?? 0) - report.prev_jira_six_month_count
    : null
  const jiraOneYearDelta = report?.prev_jira_one_year_count != null
    ? (report.jira_one_year_count ?? 0) - report.prev_jira_one_year_count
    : null

  const sortedBreakdown = report ? [...report.category_breakdown].sort((a, b) => b.count - a.count) : []
  const totalCatCount = sortedBreakdown.reduce((s, c) => s + c.count, 0)

  const unresolvedWingsRows = useMemo(
    () => wingsRows.filter(r => !r.state || !WINGS_CLOSED_STATES.has(r.state)),
    [wingsRows]
  )
  const severityModalRows = useMemo(
    () => severityModal ? unresolvedWingsRows.filter(r => severityBucketOf(r) === severityModal) : [],
    [severityModal, unresolvedWingsRows]
  )

  // id는 사이드바·헤더 없이 이 영역만 스크린샷 찍을 수 있도록 backend/features/mailer/
  // report_screenshot.py가 Playwright로 지정해서 찾는 대상이다.
  return (
    <div id="weekly-report-capture-root" className="container" style={{ fontFamily: "'Pretendard', 'Segoe UI', system-ui, sans-serif" }}>

      {/* 컨트롤바 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginBottom: 16 }}>
        <select
          value={weekStart}
          onChange={e => setWeekStart(e.target.value)}
          style={{
            padding: '7px 12px', border: '1px solid #e2e8f0', borderRadius: 8,
            fontSize: 17, color: '#374151', background: '#fff',
          }}
        >
          {mondays.map(m => (
            <option key={m} value={m}>{getWeekLabel(m)} ({m} ~ {addDays(m, 6)})</option>
          ))}
        </select>
        {isAdmin && (
          <button
            onClick={handleGenerate}
            disabled={generating || aiGenerating || loading}
            style={{
              padding: '8px 18px',
              background: generating || aiGenerating ? '#94a3b8' : NAVY,
              color: '#fff', border: 'none', borderRadius: 8,
              cursor: generating || aiGenerating ? 'default' : 'pointer',
              fontSize: 16, fontWeight: 600, whiteSpace: 'nowrap',
            }}
          >
            {generating ? '집계 중...' : aiGenerating ? 'AI 분석 중...' : report ? '↻ 재생성' : '보고서 생성'}
          </button>
        )}
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
            <div style={{ fontSize: 17, marginBottom: 8, color: '#475569' }}>
              {weekStart} ~ {weekEnd} 보고서가 없습니다.
            </div>
            {isAdmin && (
              <div style={{ fontSize: 16, color: '#cbd5e1' }}>
                "보고서 생성" 버튼을 클릭해 Gemma 분석을 시작하세요.
              </div>
            )}
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
              label="총 상담" value={totalAll.toLocaleString()} unit="건"
              color={NAVY}
              delta={totalDelta} deltaUnit="건" isSecondary
            />
            <KpiCard
              label={`영업일 ${weekdayCount}일 평균`} value={Math.round(report.daily_avg).toLocaleString()} unit="건/일"
              color={NAVY2}
              delta={dailyAvgDelta} deltaUnit="건/일" isSecondary
            />
            <KpiCard
              label="리스크 상담" value={report.risk_total.toLocaleString()} unit="건"
              color={RISK_RED}
              delta={riskDelta} deltaUnit="건" deltaPct={riskDeltaPct} deltaInvert
            />
            <KpiCard
              label="리스크 비율" value={riskPct} unit="%"
              color={Number(riskPct) > 20 ? RISK_RED : '#4f46e5'}
              delta={riskPctDelta} deltaUnit="%p" deltaInvert
            />
          </div>

          {/* 일별 건수 + SQI */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div className="section-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, paddingBottom: 14, borderBottom: '1px solid #f1f5f9' }}>
                <h2 style={{ margin: 0, fontSize: 25, color: NAVY }}>일별 상담 건수</h2>
                <span style={{ fontSize: 15, color: '#94a3b8' }}>최다 요일은 빨간색, 주말은 회색으로 표시합니다</span>
              </div>
              {/* 오른쪽(리스크 비율 추이) 카드에만 있는 범례 줄만큼, 안 보이지만 자리는 차지하는
                  더미 줄 — 안 그러면 그 줄의 높이만큼 두 캔버스의 세로 위치(그래서 가로축 위치도)가
                  어긋난다. 내용·스타일을 그대로 맞춰야 높이가 정확히 같다. */}
              <div style={{ display: 'flex', gap: 14, marginBottom: 12, fontSize: 17, color: '#64748b', visibility: 'hidden' }} aria-hidden="true">
                <span>더미</span>
              </div>
              <div style={{ height: 200, position: 'relative' }}>
                <DailyBar dailyCounts={report.daily_counts} />
              </div>
            </div>
            <div className="section-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, paddingBottom: 14, borderBottom: '1px solid #f1f5f9' }}>
                <h2 style={{ margin: 0, fontSize: 25, color: NAVY }}>리스크 비율 추이</h2>
                <span style={{ fontSize: 15, color: '#94a3b8' }}>일별 리스크 비율 변화를 주 평균 기준으로 표시합니다</span>
              </div>
              <div style={{ display: 'flex', gap: 14, marginBottom: 12, fontSize: 17, color: '#64748b' }}>
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
              <h2 style={{ margin: 0, fontSize: 25, color: NAVY }}>이번 주 상담 유형 분포</h2>
              <span style={{ fontSize: 15, color: '#94a3b8' }}>전체 상담을 카테고리별로 분류한 비율입니다</span>
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
                          display: 'flex', alignItems: 'center', gap: 5, fontSize: 17,
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
              <h2 style={{ margin: 0, fontSize: 25, color: NAVY }}>리스크 카테고리별 AI 분석</h2>
              <span style={{ fontSize: 15, color: '#94a3b8' }}>리스크 카테고리의 소분류 추이와 AI 요약을 함께 확인합니다</span>
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
                    <div key={row.main} id={`risk-row-${row.main}`} style={{
                      background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0',
                      marginBottom: 12, overflow: 'hidden',
                    }}>
                      <div style={{ padding: '12px 16px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontWeight: 700, fontSize: 22, color: '#1e293b' }}>
                            {RISK_DISPLAY_LABEL[row.main] ?? row.main}
                          </span>
                          <span style={{
                            fontSize: 22, fontWeight: 700, color: RISK_RED,
                            background: '#fef2f2', borderRadius: 6,
                            padding: '2px 8px', border: '1px solid #fecaca', flexShrink: 0,
                          }}>
                            {row.count.toLocaleString()}건
                          </span>
                        </div>
                        {cardTopSub && (
                          <div style={{ fontSize: 18, color: '#64748b', marginTop: 4 }}>
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
                              fontSize: 17, color: '#374151', lineHeight: 1.7,
                              borderLeft: `3px solid ${NAVY}`, paddingLeft: 10,
                              marginBottom: 8, whiteSpace: 'pre-line',
                            }}>
                            {row.summary}
                          </div>
                        : row.gemma_error
                        ? <p style={{ margin: '0 0 8px', fontSize: 17, fontWeight: 700, color: '#ef4444' }} title={row.gemma_error}>
                            AI 분석 실패 — 다시 시도해주세요
                          </p>
                        : <p style={{ margin: '0 0 8px', fontSize: 15 }}>
                            {aiGenerating
                              ? <span style={{ color: '#94a3b8', fontStyle: 'italic', fontSize: 17, fontWeight: 700 }}>AI 분석 중...</span>
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

          {/* 장기미해결 상담 현황 — 반복 Wings 티켓 페이지 KPI 카드와 같은 기준(미해결/2회 이상
              상담/7일+/30일+ 처리 지연)의 스냅샷. 그 페이지 카드가 항상 "지금 이 순간" 기준인
              것과 달리, 여기 값은 이 보고서가 생성된 시점 기준으로 고정 저장되어 매주 그
              시점의 스냅샷끼리 비교(전주 대비 증감)할 수 있다 — 순수 집계는
              insight_aggregations.py의 compute_wings_snapshot_counts. 카테고리 비중은 위
              "리스크 카테고리별 AI 분석"과 겹쳐서 다루지 않고, 개별 학부모를 짚는 내용도
              넣지 않는다(그건 인사이트 페이지의 반복 Wings 티켓 표에서만 다룬다). */}
          <div className="section-card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 14, borderBottom: '1px solid #f1f5f9' }}>
              <h2 style={{ margin: 0, fontSize: 25, color: NAVY }}>장기미해결 상담 현황</h2>
              <span style={{ fontSize: 15, color: '#94a3b8' }}>동일 사안으로 상담이 반복될수록 해당 가정의 해지 위험이 높아집니다</span>
            </div>
            <div style={{ fontSize: 15, color: '#94a3b8', marginBottom: 10 }}>
              카드를 클릭하면 반복 Wings 티켓 페이지에서 그 조건으로 바로 확인할 수 있습니다.
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <Link to="/insights/wings?filter=all" style={{ textDecoration: 'none', color: 'inherit', flex: '1 1 0' }}>
                <KpiCard
                  label="미해결 티켓" value={(report.wings_unresolved_count ?? 0).toLocaleString()} unit="건"
                  color={NAVY} isSecondary delta={wingsUnresolvedDelta} deltaUnit="건" deltaInvert
                />
              </Link>
              <Link to="/insights/wings?filter=repeat" style={{ textDecoration: 'none', color: 'inherit', flex: '1 1 0' }}>
                <KpiCard
                  label="2회 이상 상담" value={(report.wings_repeat_count ?? 0).toLocaleString()} unit="건"
                  color={PURPLE} isSecondary delta={wingsRepeatDelta} deltaUnit="건" deltaInvert
                />
              </Link>
              <Link to="/insights/wings?filter=delayed" style={{ textDecoration: 'none', color: 'inherit', flex: '1 1 0' }}>
                <KpiCard
                  label="7일 이상 처리 지연" value={(report.wings_delayed_7_count ?? 0).toLocaleString()} unit="건"
                  color={AMBER} isSecondary delta={wingsDelayed7Delta} deltaUnit="건" deltaInvert
                />
              </Link>
              <Link to="/insights/wings?filter=longUnresolved" style={{ textDecoration: 'none', color: 'inherit', flex: '1 1 0' }}>
                <KpiCard
                  label="30일 이상 처리 지연" value={(report.wings_delayed_30_count ?? 0).toLocaleString()} unit="건"
                  color={RISK_RED} isSecondary delta={wingsDelayed30Delta} deltaUnit="건" deltaInvert
                />
              </Link>
            </div>
            <UnresolvedSeverityBar
              total={report.wings_unresolved_count ?? 0}
              delayed7={report.wings_delayed_7_count ?? 0}
              delayed30={report.wings_delayed_30_count ?? 0}
              onSegmentClick={setSeverityModal}
            />
          </div>
          {severityModal && (
            <SeverityListModal key={severityModal} bucket={severityModal} rows={severityModalRows} onClose={() => setSeverityModal(null)} />
          )}

          {/* 반복 상담 학부모 현황 — 장기미해결 상담 현황과 같은 방식의 스냅샷(카드 크기·폰트는
              KpiCard isSecondary로 동일, report_weekly.py의 _repeat_parents_snapshot_counts가
              매주 생성 시점 값을 저장해 전주 대비 증감을 비교한다). 학부모 반복 상담 페이지의
              3개 축(동일 유형 연속·7일 이내 재상담·복합 이슈)은 서로 포함관계가 아니라
              독립적으로 겹칠 수 있는 조건이라 Wings처럼 세그먼트 바로 표현할 수 없고, 카테고리
              비중도 위 "리스크 카테고리별 AI 분석"과 겹쳐서 여기선 다루지 않는다 — 그래서
              차트 없이 카드 4개만 둔다. */}
          <div className="section-card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 14, borderBottom: '1px solid #f1f5f9' }}>
              <h2 style={{ margin: 0, fontSize: 25, color: NAVY }}>반복 상담 학부모 현황</h2>
              <span style={{ fontSize: 15, color: '#94a3b8' }}>짧은 기간 안에 반복 상담이 몰릴수록 해당 가정의 이탈 위험이 높아집니다</span>
            </div>
            <div style={{ fontSize: 15, color: '#94a3b8', marginBottom: 10 }}>
              카드를 클릭하면 학부모 반복 상담 페이지에서 그 조건으로 바로 확인할 수 있습니다.
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <Link to="/insights/parents?filter=all" style={{ textDecoration: 'none', color: 'inherit', flex: '1 1 0' }}>
                <KpiCard
                  label="반복 상담 학부모" value={(report.parents_total_count ?? 0).toLocaleString()} unit="명"
                  color={NAVY} isSecondary delta={parentsTotalDelta} deltaUnit="명" deltaInvert
                />
              </Link>
              <Link to="/insights/parents?filter=repeat" style={{ textDecoration: 'none', color: 'inherit', flex: '1 1 0' }}>
                <KpiCard
                  label="동일 유형 연속 상담" value={(report.parents_repeat_count ?? 0).toLocaleString()} unit="명"
                  color={NAVY} isSecondary delta={parentsRepeatDelta} deltaUnit="명" deltaInvert
                />
              </Link>
              <Link to="/insights/parents?filter=shortGap" style={{ textDecoration: 'none', color: 'inherit', flex: '1 1 0' }}>
                <KpiCard
                  label="7일 이내 재상담" value={(report.parents_shortgap_count ?? 0).toLocaleString()} unit="명"
                  color={NAVY} isSecondary delta={parentsShortgapDelta} deltaUnit="명" deltaInvert
                />
              </Link>
              <Link to="/insights/parents?filter=complex" style={{ textDecoration: 'none', color: 'inherit', flex: '1 1 0' }}>
                <KpiCard
                  label="복합 이슈 상담" value={(report.parents_complex_count ?? 0).toLocaleString()} unit="명"
                  color={NAVY} isSecondary delta={parentsComplexDelta} deltaUnit="명" deltaInvert
                />
              </Link>
            </div>
          </div>

          {/* 미해결 Jira 이슈 현황 — Wings/학부모 반복 상담과 같은 방식의 스냅샷(카드 크기·폰트는
              KpiCard isSecondary로 동일, report_weekly.py의 _jira_snapshot_counts가 매주 생성
              시점 값을 저장해 전주 대비 증감을 비교한다). 미해결 Jira 이슈 페이지의 6개월
              이상/1년 이상은 서로 포함관계(1년 이상이면 항상 6개월 이상)라 Wings의 7일+/30일+
              지연 카드와 같은 성격이지만, 여기선 차트 없이 카드 4개만 둔다(추이는 그 페이지의
              "미해결 건수 추이" 차트에서 이미 다룬다). */}
          <div className="section-card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 14, borderBottom: '1px solid #f1f5f9' }}>
              <h2 style={{ margin: 0, fontSize: 25, color: NAVY }}>미해결 Jira 이슈 현황</h2>
              <span style={{ fontSize: 15, color: '#94a3b8' }}>고객 서비스에 영향을 줄 수 있는 미해결 이슈 현황입니다</span>
            </div>
            <div style={{ fontSize: 15, color: '#94a3b8', marginBottom: 10 }}>
              카드를 클릭하면 미해결 Jira 이슈 페이지에서 그 조건으로 바로 확인할 수 있습니다.
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <Link to="/insights/jira-bugs?filter=all" style={{ textDecoration: 'none', color: 'inherit', flex: '1 1 0' }}>
                <KpiCard
                  label="전체 이슈" value={(report.jira_total_count ?? 0).toLocaleString()} unit="건"
                  color={NAVY} isSecondary delta={jiraTotalDelta} deltaUnit="건" deltaInvert
                />
              </Link>
              <Link to="/insights/jira-bugs?filter=pendingReview" style={{ textDecoration: 'none', color: 'inherit', flex: '1 1 0' }}>
                <KpiCard
                  label="검토 대기 이슈" value={(report.jira_pending_review_count ?? 0).toLocaleString()} unit="건"
                  color={NAVY} isSecondary delta={jiraPendingReviewDelta} deltaUnit="건" deltaInvert
                />
              </Link>
              <Link to="/insights/jira-bugs?filter=sixMonth" style={{ textDecoration: 'none', color: 'inherit', flex: '1 1 0' }}>
                <KpiCard
                  label="6개월 이상" value={(report.jira_six_month_count ?? 0).toLocaleString()} unit="건"
                  color={NAVY} isSecondary delta={jiraSixMonthDelta} deltaUnit="건" deltaInvert
                />
              </Link>
              <Link to="/insights/jira-bugs?filter=oneYear" style={{ textDecoration: 'none', color: 'inherit', flex: '1 1 0' }}>
                <KpiCard
                  label="1년 이상" value={(report.jira_one_year_count ?? 0).toLocaleString()} unit="건"
                  color={NAVY} isSecondary delta={jiraOneYearDelta} deltaUnit="건" deltaInvert
                />
              </Link>
            </div>
          </div>

          {/* 이번 주 해결된 Jira 이슈 — 미해결 Jira 이슈 페이지의 "최근 1주일 내 해결된 이슈"
              표를 그대로 가져온다(컬럼·정렬 동일). 그 페이지는 매 방문 시 최신 상태를 다시
              불러오지만, 여기는 보고서 생성 시점에 report_weekly.py가 jira_resolved_issues
              캐시를 읽어 content에 통째로 저장해둔 값을 그대로 보여준다 — 예전 보고서를
              다시 열어봐도 그때 값이 유지되어야 하기 때문(오늘 기준 최신 값으로 바뀌면 안 됨). */}
          <div className="section-card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 14, borderBottom: '1px solid #f1f5f9' }}>
              <h2 style={{ margin: 0, fontSize: 25, color: NAVY }}>이번 주 해결된 Jira 이슈</h2>
              <span style={{ fontSize: 15, color: '#94a3b8' }}>
                최근 7일 내 해결된 이슈 기준이며, 미해결 Jira 이슈 페이지와 집계 시점이 다를 수 있습니다
              </span>
            </div>
            {!report.jira_resolved_bugs?.length ? (
              <div style={{ fontSize: 18, color: '#94a3b8' }}>이번 주에 새로 해결된 이슈가 없습니다.</div>
            ) : (
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
                    {report.jira_resolved_bugs.map(bug => (
                      <tr key={bug.key}>
                        <td>
                          <a
                            href={`https://danbiedu-dev.atlassian.net/browse/${bug.key}`}
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
            )}
          </div>

          {/* 주간 종합 분석 (전체 폭) */}
          <div className="section-card" id="summary-section">
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #f1f5f9',
            }}>
              <h2 style={{ margin: 0, color: NAVY, fontSize: 25 }}>이번 주 상담 종합 브리핑</h2>
              <span style={{ fontSize: 15, color: '#94a3b8' }}>이번 주 상담 전반을 AI가 핵심 패턴 중심으로 종합 분석합니다</span>
            </div>
            {report.weekly_summary
              ? (
                <div style={{
                  fontSize: 18, color: '#374151', lineHeight: 1.7,
                  background: '#f0f4fb', borderRadius: 6,
                  padding: '10px 14px', borderLeft: `3px solid ${NAVY}`,
                  whiteSpace: 'pre-line',
                }}>
                  {report.weekly_summary}
                </div>
              )
              : report.weekly_summary_error
                ? <div style={{ fontSize: 18, color: '#ef4444' }} title={report.weekly_summary_error}>
                    AI 분석 실패 — 다시 시도해주세요
                  </div>
                : aiGenerating
                  ? <div style={{ fontSize: 18, color: '#94a3b8', fontStyle: 'italic' }}>AI 분석 중...</div>
                  : <div style={{ fontSize: 18, color: '#94a3b8' }}>분석 없음</div>
            }
          </div>

          {isAdmin && adminToken && (
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
                adminToken={adminToken}
                onCategoryResult={(main, summary, gemmaError) => {
                  setReport(prev => prev ? {
                    ...prev,
                    risk_rows: prev.risk_rows.map(r => r.main === main ? { ...r, summary, gemma_error: gemmaError } : r),
                  } : prev)
                }}
                onSummaryResult={(summary, gemmaError) => {
                  setReport(prev => prev ? { ...prev, weekly_summary: summary, weekly_summary_error: gemmaError } : prev)
                }}
              />
            )}
          </div>
          )}
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
