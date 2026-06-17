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

// ── 툴팁 ─────────────────────────────────────────────────────────────────────

function InfoTooltip({ text }: { text: string }) {
  const [visible, setVisible] = useState(false)
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <span
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        style={{ fontSize: 13, color: '#94a3b8', cursor: 'default', userSelect: 'none' }}
      >ℹ</span>
      {visible && (
        <span style={{
          position: 'absolute', left: 20, top: -4, zIndex: 10,
          background: '#1e293b', color: '#e2e8f0',
          fontSize: 11, lineHeight: 1.6, whiteSpace: 'nowrap',
          borderRadius: 6, padding: '6px 10px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        }}>
          {text}
        </span>
      )}
    </span>
  )
}

// ── KPI 카드 ──────────────────────────────────────────────────────────────────

function KpiCard({ label, value, unit, color }: { label: string; value: string; unit: string; color: string }) {
  return (
    <div style={{
      background: '#fff',
      borderRadius: 14,
      padding: '20px 24px',
      boxShadow: '0 1px 6px rgba(0,0,0,.07)',
      borderTop: `4px solid ${color}`,
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
    </div>
  )
}

// ── 리스크 바 차트 ────────────────────────────────────────────────────────────

function RiskBarChart({ rows }: { rows: RiskRow[] }) {
  const totals = rows.map(r => r.main_total ?? r.count)
  const max = Math.max(...totals, 1)
  return (
    <div>
      {rows.map((row, i) => {
        const total = row.main_total ?? row.count
        const isTop = total === max
        return (
          <div key={i} style={{ marginBottom: i < rows.length - 1 ? 18 : 0 }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', marginBottom: 6,
            }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: isTop ? RISK_RED : '#1e293b' }}>
                {row.main}
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, color: isTop ? RISK_RED : NAVY, flexShrink: 0, marginLeft: 12 }}>
                {total.toLocaleString()}건
              </span>
            </div>
            <div style={{ background: '#e8eef6', borderRadius: 6, height: 10 }}>
              <div style={{
                width: `${(total / max) * 100}%`,
                background: isTop
                  ? `linear-gradient(90deg, ${RISK_RED}, #f87171)`
                  : `linear-gradient(90deg, ${NAVY}, ${NAVY2})`,
                height: '100%', borderRadius: 6,
                minWidth: total > 0 ? 4 : 0,
              }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── 리스크 행 ─────────────────────────────────────────────────────────────────

const MEMOS_PER_PAGE = 20

function RiskRowItem({ row, aiLoading = false }: { row: RiskRow; aiLoading?: boolean }) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(0)

  const memos = row.memos ?? []
  const pageCount = Math.ceil(memos.length / MEMOS_PER_PAGE)
  const pageMemos = memos.slice(page * MEMOS_PER_PAGE, (page + 1) * MEMOS_PER_PAGE)

  return (
    <div style={{ borderBottom: '1px solid #f1f5f9', paddingBottom: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: '#94a3b8' }}>{row.main}</span>
            <span style={{ fontSize: 11, color: '#cbd5e1' }}>›</span>
            <span style={{ fontWeight: 700, fontSize: 14, color: '#1e293b' }}>{row.sub}</span>
            <span style={{
              fontSize: 12, fontWeight: 700, color: RISK_RED,
              background: '#fef2f2', borderRadius: 6,
              padding: '2px 8px', border: '1px solid #fecaca',
            }}>
              {row.count}건
            </span>
            {row.count > 0 && (
              <span
                onClick={() => { setOpen(o => !o); setPage(0) }}
                style={{
                  fontSize: 12, color: '#64748b',
                  cursor: 'pointer', userSelect: 'none',
                  textDecoration: 'underline', textDecorationStyle: 'dotted',
                }}
              >
                {open ? '접기' : '펼치기'}
              </span>
            )}
          </div>
          {row.summary ? (
            <div style={{
              fontSize: 13, color: '#374151', lineHeight: 1.6,
              background: '#f0f4fb', borderRadius: 6,
              padding: '7px 12px', borderLeft: `3px solid ${NAVY}`,
            }}>
              {row.summary}
            </div>
          ) : aiLoading ? (
            <div style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }}>AI 분석 중...</div>
          ) : (
            <div style={{ fontSize: 12, color: '#94a3b8' }}>(AI 요약 없음)</div>
          )}
        </div>
      </div>

      {open && (
        <div style={{
          marginTop: 10, background: '#f8fafc',
          borderRadius: 8, overflow: 'hidden',
          border: '1px solid #e2e8f0',
        }}>
          {pageMemos.map((m, i) => (
            <div
              key={m.id}
              style={{
                padding: '8px 12px',
                borderBottom: i < pageMemos.length - 1 ? '1px solid #e2e8f0' : undefined,
                fontSize: 13, color: '#374151', lineHeight: 1.6,
              }}
            >
              {m.text
                ? m.text.split('\n').map((line, li) => (
                    <Fragment key={li}>{li > 0 && <br />}{line}</Fragment>
                  ))
                : <span style={{ color: '#94a3b8' }}>(메모 없음)</span>
              }
            </div>
          ))}
          {pageCount > 1 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 12px', borderTop: '1px solid #e2e8f0',
              fontSize: 12, color: '#64748b',
            }}>
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                style={{ padding: '2px 8px', cursor: page === 0 ? 'default' : 'pointer', borderRadius: 4, border: '1px solid #e2e8f0', background: '#fff' }}
              >‹</button>
              <span>{page + 1} / {pageCount}</span>
              <button
                onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                disabled={page === pageCount - 1}
                style={{ padding: '2px 8px', cursor: page === pageCount - 1 ? 'default' : 'pointer', borderRadius: 4, border: '1px solid #e2e8f0', background: '#fff' }}
              >›</button>
              <span style={{ marginLeft: 8, color: '#94a3b8' }}>
                {page * MEMOS_PER_PAGE + 1}~{Math.min((page + 1) * MEMOS_PER_PAGE, memos.length)}건 / 전체 {memos.length}건
              </span>
            </div>
          )}
        </div>
      )}
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

      // 2단계: AI 분석 → 요약 채움
      setAiGenerating(true)
      const fullData = await api.generateDailyReport(date)
      setReport(fullData)
      const canNotify = await requestNotificationPermission()
      if (canNotify) {
        const url = `${window.location.origin}/report/daily?date=${fullData.report_date}`
        showReportNotification(fullData, url)
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
          <div className="loading">불러오는 중...</div>
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 16 }}>
            <KpiCard label="총 상담" value={report.total_count.toLocaleString()} unit="건" color={NAVY} />
            <KpiCard label="리스크 이슈" value={report.risk_total.toLocaleString()} unit="건" color={RISK_RED} />
            <KpiCard label="리스크 비율" value={riskPct} unit="%" color="#f59e0b" />
          </div>

          {/* 리스크 카테고리 현황 — 바 차트 */}
          {report.risk_rows.length > 0 && (
            <div className="section-card">
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                marginBottom: 20, paddingBottom: 14, borderBottom: '1px solid #f1f5f9',
              }}>
                <h3 style={{ margin: 0, color: NAVY, fontSize: 15 }}>리스크 카테고리 현황</h3>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>대분류별 최다 발생 소분류</span>
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
              <h3 style={{ margin: 0, color: NAVY, fontSize: 15 }}>카테고리별 AI 분석</h3>
              <InfoTooltip text="각 대분류 내 당일 최다 발생 소분류 1개만 목록에 표시 / 전체 리스크 건수는 해당 대분류 모든 소분류 합산" />
            </div>
            {report.risk_rows.length === 0 ? (
              <div style={{ color: '#94a3b8', fontSize: 13 }}>리스크 카테고리 데이터 없음</div>
            ) : (
              report.risk_rows.map((row, i) => (
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
              <h3 style={{ margin: 0, color: NAVY, fontSize: 15 }}>피크타임 특이사항</h3>
            </div>
            <PeakBucketChart buckets={peakBuckets} />
            {!report.peak_bucket ? (
              aiGenerating
                ? <div style={{ fontSize: 13, color: '#94a3b8', fontStyle: 'italic' }}>AI 분석 중...</div>
                : <div style={{ fontSize: 13, color: '#94a3b8' }}>피크타임 데이터가 없습니다.</div>
            ) : !report.peak_bucket.has_pattern ? (
              <div style={{ fontSize: 13, color: '#94a3b8' }}>이 날 피크타임에 특이한 패턴이 없습니다.</div>
            ) : (
              <div>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
                  {report.peak_bucket.bucket_start}~{report.peak_bucket.bucket_end} 집중
                </div>
                <div style={{
                  fontSize: 13, color: '#374151', lineHeight: 1.6,
                  background: '#f0f4fb', borderRadius: 6,
                  padding: '7px 12px', borderLeft: `3px solid ${NAVY}`,
                }}>
                  <span style={{
                    display: 'inline-block', fontSize: 10, fontWeight: 700,
                    color: NAVY, background: '#dbeafe', borderRadius: 4,
                    padding: '1px 6px', marginBottom: 5, letterSpacing: '0.03em',
                  }}>AI 분석</span>
                  <div>{report.peak_bucket.summary}</div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
