// 일별 CS 보고서 페이지.
// 날짜를 선택하면 저장된 보고서를 불러오고, 없으면 생성 버튼으로 Ollama 기반 보고서를 생성한다.
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
//   POST /api/report/daily/generate?date=YYYY-MM-DD → 보고서 생성 (Ollama 호출)
//
// 의존: api/client.ts (DailyReport, RiskRow, PeakBucket 타입, fetchDailyReport, generateDailyReport)
import { Fragment, useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, type DailyReport, type RiskRow, type BucketRow } from '../../api/client'

const NAVY = '#1e3c72'
const NAVY2 = '#2a5298'
const RISK_RED = '#ef4444'

const RISK_MAINS = ['네트워크·앱 오류', '기기·하드웨어 오류', '교재·물류·배송']

// ── 카테고리 AI 분석 패널 ──────────────────────────────────────────────────────

const TEST_TARGETS = ['피크타임 패턴 분석', ...RISK_MAINS]

type CategoryResult = { main?: string; sub: string; count: number; summary: string; insufficient_data: boolean; prompt_section: string }
type PeakResult = { bucket_start: string; bucket_end: string; bucket_count: number; avg_count: number; pattern: string; summary: string; has_pattern: boolean; insufficient_data: boolean; prompt_section: string }

function CategoryTestPanel({
  date,
  onCategoryResult,
  onPeakResult,
}: {
  date: string
  onCategoryResult: (main: string, summary: string) => void
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
        onCategoryResult(target, data.summary)
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
            {!peakResult.insufficient_data && (
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

function DeltaBadge({ delta, unit, invert }: { delta: number | null | undefined; unit: string; invert?: boolean }) {
  if (delta == null) return null
  if (delta === 0) return <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 5 }}>전일 동일</div>
  const isPositive = delta > 0
  const color = invert
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
  label, value, unit, color, delta, deltaUnit, deltaInvert, isSecondary,
}: {
  label: string; value: string; unit: string; color: string
  delta?: number | null; deltaUnit?: string; deltaInvert?: boolean; isSecondary?: boolean
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
      <DeltaBadge delta={delta} unit={deltaUnit ?? ''} invert={deltaInvert} />
    </div>
  )
}

// ── 리스크 바 차트 ────────────────────────────────────────────────────────────


function RiskBarChart({ rows }: { rows: RiskRow[] }) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [pages, setPages] = useState<Record<string, number>>({})

  const sorted = [...rows].sort((a, b) => (b.main_total ?? b.count) - (a.main_total ?? a.count))
  const allSubCounts = sorted.flatMap(r => (r.subs?.length ? r.subs.map(s => s.count) : [r.count]))
  const max = Math.max(...allSubCounts, 1)
  const topRow = sorted[0]

  function toggleKey(key: string) {
    setExpandedKey(prev => prev === key ? null : key)
    setPages(prev => ({ ...prev, [key]: 0 }))
  }
  function getPage(key: string) { return pages[key] ?? 0 }
  function setPage(key: string, p: number) { setPages(prev => ({ ...prev, [key]: p })) }

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
          <span style={{ fontSize: 15, fontWeight: 700, color: '#ef4444' }}>({(topRow.main_total ?? topRow.count).toLocaleString()}건)</span>
        </div>
      )}
      {sorted.map((row, i) => {
        const subs = row.subs?.length ? row.subs : [{ sub: row.sub, count: row.count, memos: row.memos }]
        return (
          <div key={i} style={{ marginBottom: i < sorted.length - 1 ? 22 : 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: '#1e293b' }}>{row.main}</span>
              <span style={{ fontSize: 14, color: '#94a3b8' }}>총 {(row.main_total ?? row.count).toLocaleString()}건</span>
            </div>
            {subs.map((s, si) => {
              const isTop = si === 0
              const key = `${row.main}:${s.sub}`
              const memos = s.memos ?? []
              const isExpanded = expandedKey === key
              const curPage = getPage(key)
              const pageCount = Math.ceil(memos.length / MEMOS_PER_PAGE)
              const pageMemos = memos.slice(curPage * MEMOS_PER_PAGE, (curPage + 1) * MEMOS_PER_PAGE)
              return (
                <div key={si} style={{ paddingLeft: 12, marginBottom: si < subs.length - 1 ? 10 : 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 16, fontWeight: isTop ? 700 : 400, color: isTop ? '#ef4444' : '#374151' }}>
                      {s.sub}
                    </span>
                    <span
                      onClick={memos.length > 0 ? () => toggleKey(key) : undefined}
                      style={{
                        fontSize: 17, fontWeight: isTop ? 700 : 500,
                        color: isTop ? '#ef4444' : '#64748b',
                        cursor: memos.length > 0 ? 'pointer' : 'default',
                        userSelect: 'none', flexShrink: 0, marginLeft: 8,
                      }}
                    >
                      {s.count.toLocaleString()}건{memos.length > 0 ? ` ${isExpanded ? '▲' : '▼'}` : ''}
                    </span>
                  </div>
                  <div style={{ background: '#e8eef6', borderRadius: 4, height: 7 }}>
                    <div style={{ width: `${(s.count / max) * 100}%`, background: isTop ? '#ef4444' : '#94a3b8', height: '100%', borderRadius: 4, minWidth: s.count > 0 ? 3 : 0 }} />
                  </div>
                  {isExpanded && (
                    <div style={{ marginTop: 8, borderRadius: 8, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
                      {pageMemos.map((m, mi) => (
                        <div key={m.id} style={{ padding: '8px 12px', fontSize: 12, color: '#374151', lineHeight: 1.6, borderBottom: mi < pageMemos.length - 1 ? '1px solid #f1f5f9' : undefined, background: mi % 2 === 0 ? '#fff' : '#fafafa' }}>
                          {m.text
                            ? m.text.split('\n').map((line, li) => <Fragment key={li}>{li > 0 && <br />}{line}</Fragment>)
                            : <span style={{ color: '#94a3b8' }}>메모 없음</span>
                          }
                        </div>
                      ))}
                      {pageCount > 1 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderTop: '1px solid #e2e8f0', fontSize: 12, color: '#64748b', background: '#f8fafc' }}>
                          <button onClick={() => setPage(key, Math.max(0, curPage - 1))} disabled={curPage === 0} style={{ padding: '2px 8px', cursor: curPage === 0 ? 'default' : 'pointer', borderRadius: 4, border: '1px solid #e2e8f0', background: '#fff' }}>‹</button>
                          <span>{curPage + 1} / {pageCount}</span>
                          <button onClick={() => setPage(key, Math.min(pageCount - 1, curPage + 1))} disabled={curPage === pageCount - 1} style={{ padding: '2px 8px', cursor: curPage === pageCount - 1 ? 'default' : 'pointer', borderRadius: 4, border: '1px solid #e2e8f0', background: '#fff' }}>›</button>
                          <span style={{ marginLeft: 8, color: '#94a3b8' }}>{curPage * MEMOS_PER_PAGE + 1}~{Math.min((curPage + 1) * MEMOS_PER_PAGE, memos.length)}건 / 전체 {memos.length}건</span>
                        </div>
                      )}
                    </div>
                  )}
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

const MEMOS_PER_PAGE = 20

function RiskRowItem({ row, aiLoading = false }: { row: RiskRow; aiLoading?: boolean }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0', marginBottom: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>{row.main}</span>
        <span style={{ fontSize: 12, color: '#cbd5e1' }}>›</span>
        <span style={{ fontWeight: 700, fontSize: 15, color: '#1e293b', flex: 1 }}>{row.sub}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: RISK_RED, background: '#fef2f2', borderRadius: 6, padding: '2px 8px', border: '1px solid #fecaca', flexShrink: 0 }}>
          {row.count}건
        </span>
      </div>
      <div style={{ padding: '10px 16px' }}>
        {row.summary ? (
          <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.7, borderLeft: `3px solid ${NAVY}`, paddingLeft: 10 }}>
            {row.summary}
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

// ── 피크타임 30분 버킷 차트 ───────────────────────────────────────────────────

// UTC 08:00~11:30 = KST 17:00~20:30
function filterPeakBuckets(buckets: BucketRow[]): BucketRow[] {
  return buckets.filter(b => {
    const hour = parseInt(b.bucket.slice(11, 13), 10)
    return hour >= 8 && hour <= 11
  })
}

function bucketToKstLabel(bucket: string): string {
  const utcHour = parseInt(bucket.slice(11, 13), 10)
  const min = bucket.slice(14, 16)
  const kstHour = (utcHour + 9) % 24
  return `${kstHour}:${min}`
}

function PeakBucketChart({ buckets }: { buckets: BucketRow[] }) {
  if (buckets.length === 0) return null
  const max = Math.max(...buckets.map(b => b.count), 1)
  const BAR_MAX_H = 64

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: BAR_MAX_H + 20 }}>
        {buckets.map(b => {
          const h = Math.round((b.count / max) * BAR_MAX_H)
          const isMax = b.count > 0 && b.count === max
          return (
            <div key={b.bucket} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end' }}>
              <span style={{ fontSize: 10, color: isMax ? RISK_RED : '#64748b', fontWeight: isMax ? 700 : 400, marginBottom: 3 }}>{b.count}</span>
              <div style={{
                width: '100%', height: h,
                background: isMax
                  ? `linear-gradient(180deg, ${RISK_RED}, #f87171)`
                  : `linear-gradient(180deg, ${NAVY}, ${NAVY2})`,
                borderRadius: '3px 3px 0 0',
                minHeight: b.count > 0 ? 3 : 0,
              }} />
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
        {buckets.map(b => (
          <div key={b.bucket} style={{ flex: 1, textAlign: 'center', fontSize: 9, color: '#94a3b8' }}>
            {bucketToKstLabel(b.bucket)}
          </div>
        ))}
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
      setPeakBuckets(filterPeakBuckets(buckets))
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
      setPeakBuckets(filterPeakBuckets(buckets))
      setNotFound(false)
      setGenerating(false)

      // 2단계: AI 분석 — 카테고리별 순차 호출, 완료되는 즉시 반영
      setAiGenerating(true)
      for (const row of statsData.risk_rows) {
        try {
          const result = await api.analyzeDailyCategory(date, row.main)
          setReport(prev => prev ? {
            ...prev,
            risk_rows: prev.risk_rows.map(r =>
              r.main === row.main
                ? { ...r, summary: result.summary, insufficient_data: result.insufficient_data }
                : r
            ),
          } : prev)
        } catch (e) {
          console.error(`[AI] ${row.main} 분석 실패`, e)
        }
      }
      try {
        const peakResult = await api.analyzeDailyPeak(date)
        setReport(prev => prev ? { ...prev, peak_bucket: peakResult } : prev)
      } catch (e) {
        console.error('[AI] 피크타임 분석 실패', e)
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
              "보고서 생성" 버튼을 클릭해 Ollama 분석을 시작하세요.
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
            <div style={{ fontSize: 15, opacity: 0.8 }}>
              {report.report_date}
            </div>
          </div>

          {/* KPI 카드 3개 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.35fr 1.35fr', gap: 14, marginBottom: 16 }}>
            <KpiCard
              label="총 상담" value={report.total_count.toLocaleString()} unit="건" color={NAVY}
              delta={totalDelta} deltaUnit="건" isSecondary
            />
            <KpiCard
              label="리스크 이슈" value={report.risk_total.toLocaleString()} unit="건" color={RISK_RED}
              delta={riskDelta} deltaUnit="건" deltaInvert
            />
            <KpiCard
              label="리스크 비율" value={riskPct} unit="%" color="#f59e0b"
              delta={riskPctDelta} deltaUnit="%" deltaInvert
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
              <RiskBarChart rows={report.risk_rows} />
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
            <PeakBucketChart buckets={peakBuckets} />
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
                    집중 (피크타임 평균 {report.peak_bucket.avg_count}건)
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
                {report.peak_bucket.summary && (
                  <div style={{
                    fontSize: 13, color: '#374151', lineHeight: 1.7,
                    borderLeft: `3px solid ${NAVY}`, paddingLeft: 10,
                  }}>
                    {report.peak_bucket.summary}
                  </div>
                )}
              </div>
            )}
          </div>

          <CategoryTestPanel
            date={date}
            onCategoryResult={(main, summary) => {
              setReport(prev => prev ? {
                ...prev,
                risk_rows: prev.risk_rows.map(r => r.main === main ? { ...r, summary } : r),
              } : prev)
            }}
            onPeakResult={(peak) => {
              setReport(prev => prev ? { ...prev, peak_bucket: peak } : prev)
            }}
          />

        </>
      )}
    </div>
  )
}
