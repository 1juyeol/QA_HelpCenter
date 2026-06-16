// 일별 CS 보고서 페이지.
// 날짜를 선택하면 저장된 보고서를 불러오고, 없으면 생성 버튼으로 Ollama 기반 보고서를 생성한다.
//
// 섹션 구성:
//   1. 총 상담건수 (가볍게)
//   2. 고객 리스크 이슈 — 대분류별 1등 소분류 최대 5개, 각 행에 Ollama 1줄 요약 + 메모 드롭다운(20개씩)
//   3. 17~20시 이슈 분석 — Ollama 2줄 bullet
//   4. 시간대 바 차트 — 24시간, 17~20시 강조
//
// 데이터 흐름:
//   GET  /api/report/daily?date=YYYY-MM-DD  → 저장된 보고서 반환 (없으면 404)
//   POST /api/report/daily/generate?date=YYYY-MM-DD → 보고서 생성 (Ollama 2회 호출)
//
// 의존: api/client.ts (DailyReport, RiskRow 타입, fetchDailyReport, generateDailyReport)
import { Fragment, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, type DailyReport, type RiskRow } from '../../api/client'

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

// ── 시간대 바 차트 ────────────────────────────────────────────────────────

function HourlyChart({ hourly }: { hourly: [number, number][] }) {
  const maxCount = Math.max(...hourly.map(([, c]) => c), 1)
  const isPeak = (h: number) => h >= 17 && h <= 20

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 80, marginTop: 8 }}>
      {hourly.map(([h, c]) => (
        <div
          key={h}
          title={`${h}시: ${c}건`}
          style={{
            flex: 1,
            height: `${(c / maxCount) * 100}%`,
            minHeight: c > 0 ? 3 : 0,
            background: isPeak(h) ? '#ef4444' : '#cbd5e1',
            borderRadius: '2px 2px 0 0',
            transition: 'height 0.2s',
          }}
        />
      ))}
    </div>
  )
}

function HourlyXAxis({ hourly }: { hourly: [number, number][] }) {
  return (
    <div style={{ display: 'flex', gap: 3, marginTop: 4 }}>
      {hourly.map(([h]) => (
        <div
          key={h}
          style={{
            flex: 1,
            textAlign: 'center',
            fontSize: 9,
            color: h >= 17 && h <= 20 ? '#ef4444' : '#94a3b8',
            fontWeight: h >= 17 && h <= 20 ? 700 : 400,
          }}
        >
          {h % 4 === 0 || (h >= 17 && h <= 20) ? h : ''}
        </div>
      ))}
    </div>
  )
}

// ── 리스크 행 ─────────────────────────────────────────────────────────────

const MEMOS_PER_PAGE = 20

function RiskRowItem({ row }: { row: RiskRow }) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(0)

  const memos = row.memos
  const pageCount = Math.ceil(memos.length / MEMOS_PER_PAGE)
  const pageMemos = memos.slice(page * MEMOS_PER_PAGE, (page + 1) * MEMOS_PER_PAGE)

  return (
    <div style={{
      borderBottom: '1px solid #f1f5f9',
      paddingBottom: 12,
      marginBottom: 12,
    }}>
      {/* 헤더 행 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 13, color: '#64748b' }}>{row.main}</span>
            <span style={{ fontSize: 12, color: '#94a3b8' }}>›</span>
            <span style={{ fontWeight: 600, fontSize: 14, color: '#1e293b' }}>{row.sub}</span>
            <span style={{
              fontSize: 12, fontWeight: 700, color: '#ef4444',
              background: '#fef2f2', borderRadius: 6,
              padding: '2px 8px', border: '1px solid #fecaca',
            }}>
              {row.count}건
            </span>
          </div>
          {row.summary && (
            <div style={{
              fontSize: 13, color: '#374151', lineHeight: 1.5,
              background: '#f8fafc', borderRadius: 6,
              padding: '6px 10px', borderLeft: '3px solid #3b82f6',
              marginBottom: 6,
            }}>
              {row.summary}
            </div>
          )}
          {!row.summary && (
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>
              (AI 요약 없음)
            </div>
          )}
        </div>
        <button
          onClick={() => { setOpen(o => !o); setPage(0) }}
          style={{
            fontSize: 12, padding: '4px 10px',
            border: '1px solid #e2e8f0', borderRadius: 6,
            background: open ? '#f1f5f9' : '#fff',
            cursor: 'pointer', color: '#374151',
            whiteSpace: 'nowrap', flexShrink: 0,
          }}
        >
          {open ? '▼ 접기' : `▶ 메모 ${memos.length}건`}
        </button>
      </div>

      {/* 메모 드롭다운 */}
      {open && (
        <div style={{
          marginTop: 8, background: '#f8fafc',
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

// ── 메인 페이지 ───────────────────────────────────────────────────────────

export default function DailyReport() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [date, setDate] = useState(() => searchParams.get('date') ?? yesterday())
  const [report, setReport] = useState<DailyReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    setSearchParams({ date }, { replace: true })
    loadReport(date)
  }, [date])

  async function loadReport(d: string) {
    setLoading(true)
    setReport(null)
    setNotFound(false)
    try {
      const data = await api.fetchDailyReport(d)
      setReport(data)
    } catch {
      setNotFound(true)
    } finally {
      setLoading(false)
    }
  }

  async function handleGenerate() {
    setGenerating(true)
    try {
      const data = await api.generateDailyReport(date)
      setReport(data)
      setNotFound(false)
      const canNotify = await requestNotificationPermission()
      if (canNotify) {
        const url = `${window.location.origin}/report/daily?date=${data.report_date}`
        showReportNotification(data, url)
      }
    } catch (e) {
      alert(`보고서 생성 실패: ${e}`)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="container">
      {/* 헤더 */}
      <div className="section-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>📋 일별 CS 보고서</h2>
            <p style={{ fontSize: 13, color: '#94a3b8', margin: 0 }}>
              고객 리스크 카테고리 이슈와 AI 분석 인사이트를 요약합니다. 독자: 개발본부장.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              style={{
                padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 8,
                fontSize: 14, color: '#374151', background: '#fff',
              }}
            />
            <button
              onClick={handleGenerate}
              disabled={generating || loading}
              style={{
                padding: '8px 16px', background: generating ? '#94a3b8' : '#3b82f6',
                color: '#fff', border: 'none', borderRadius: 8,
                cursor: generating ? 'default' : 'pointer',
                fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
              }}
            >
              {generating ? '생성 중...' : report ? '↻ 재생성' : '보고서 생성'}
            </button>
          </div>
        </div>
      </div>

      {/* 로딩 / 빈 상태 */}
      {loading && (
        <div className="section-card">
          <div className="loading">불러오는 중...</div>
        </div>
      )}
      {!loading && notFound && !generating && (
        <div className="section-card">
          <div style={{ padding: '32px 0', textAlign: 'center', color: '#94a3b8' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📄</div>
            <div style={{ fontSize: 14, marginBottom: 8 }}>{date} 보고서가 없습니다.</div>
            <div style={{ fontSize: 13, color: '#cbd5e1' }}>
              위의 "보고서 생성" 버튼을 클릭해 Ollama 분석을 시작하세요.
            </div>
          </div>
        </div>
      )}
      {generating && !report && (
        <div className="section-card">
          <div style={{ padding: '32px 0', textAlign: 'center', color: '#64748b' }}>
            <div style={{ fontSize: 13, marginBottom: 8 }}>Ollama 분석 중...</div>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>카테고리 요약 + 17~20시 분석 (1~2분 소요)</div>
          </div>
        </div>
      )}

      {/* 보고서 본문 */}
      {report && (
        <>
          {/* 총 상담건수 */}
          <div className="section-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: '#64748b' }}>총 상담</span>
              <span style={{ fontSize: 24, fontWeight: 700, color: '#1e293b' }}>
                {report.total_count.toLocaleString()}건
              </span>
              <span style={{ fontSize: 13, color: '#94a3b8', marginLeft: 8 }}>
                생성: {report.generated_at?.slice(0, 16) ?? '—'}
              </span>
            </div>
          </div>

          {/* 고객 리스크 이슈 */}
          <div className="section-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>고객 리스크 이슈</h3>
              <span style={{
                fontSize: 14, fontWeight: 700, color: '#fff',
                background: '#ef4444', borderRadius: 8,
                padding: '3px 12px',
              }}>
                {report.risk_total}건
              </span>
            </div>
            {report.risk_rows.length === 0 ? (
              <div style={{ color: '#94a3b8', fontSize: 13 }}>리스크 카테고리 데이터 없음</div>
            ) : (
              report.risk_rows.map((row, i) => (
                <RiskRowItem key={i} row={row} />
              ))
            )}
          </div>

          {/* 17~20시 이슈 분석 */}
          <div className="section-card">
            <h3 style={{ marginBottom: 12 }}>17~20시 이슈 분석</h3>
            {report.peak_window_points.length === 0 ? (
              <div style={{ color: '#94a3b8', fontSize: 13 }}>Ollama 분석 결과 없음</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8 }}>
                {report.peak_window_points.map((pt, i) => (
                  <li key={i} style={{ fontSize: 14, color: '#374151' }}>{pt}</li>
                ))}
              </ul>
            )}
          </div>

          {/* 시간대 바 차트 */}
          <div className="section-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>시간대별 상담 건수</h3>
              <span style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 10, height: 10, background: '#ef4444', display: 'inline-block', borderRadius: 2 }} />
                17~20시
              </span>
            </div>
            <HourlyChart hourly={report.hourly} />
            <HourlyXAxis hourly={report.hourly} />
          </div>
        </>
      )}
    </div>
  )
}
