// 해지 사유 분석 인사이트 페이지. "이탈·교체 원인 분석" 하위 메뉴 중 해지 쪽 절반.
// *해지요청 사유 필드가 있는 상담 메모만 사유별로 묶어 보여준다 (필드 없는 메모는 사유가
// 이질적인 자유 텍스트라 집계에서 제외 — 전체 해지·유지 상담 중 일부만 대상).
// 각 사유 카드를 클릭하면 실제 상담 메모 원문을 펼쳐서 확인할 수 있다.
// 데이터: GET /api/insights/churn_reasons (캐시 없이 즉시 집계).
import { useEffect, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import { api, type ChurnReasonStats } from '../../api/client'

const CHART_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#64748b', '#0d9488']

export default function ChurnReasonInsight() {
  const [churn, setChurn] = useState<ChurnReasonStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [openBucket, setOpenBucket] = useState<string | null>(null)

  const chartRef = useRef<HTMLCanvasElement>(null)
  const chart = useRef<Chart | null>(null)

  useEffect(() => {
    setLoading(true)
    api.fetchChurnReasons().then(setChurn).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (loading || !churn?.buckets.length || !chartRef.current) return
    chart.current?.destroy()
    chart.current = new Chart(chartRef.current, {
      type: 'doughnut',
      data: {
        labels: churn.buckets.map(b => b.name),
        datasets: [{ data: churn.buckets.map(b => b.count), backgroundColor: CHART_COLORS, borderWidth: 0 }],
      },
      options: {
        cutout: '62%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 10, font: { size: 17 }, color: '#6b7689' } },
          tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed}건` } },
        },
      },
    })
  }, [loading, churn])

  useEffect(() => () => { chart.current?.destroy() }, [])

  const maxCount = churn?.buckets[0]?.count ?? 1

  return (
    <div className="qi-page">
      <div className="qi-head">
        <div className="qi-icon">📤</div>
        <div className="qi-head-text">
          <h1>해지 사유 분석</h1>
          <p>
            해지·유지 상담 중 해지요청 사유가 기록된 건만 사유별로 집계했습니다. 사유
            미기재 건은 집계에서 제외됩니다.
          </p>
        </div>
        <span className="qi-chip">{churn ? `사유 명시 ${churn.total}건 기준` : '조회 중'}</span>
      </div>

      {loading ? (
        <div className="loading">조회 중...</div>
      ) : !churn?.buckets.length ? (
        <div className="empty">데이터 없음</div>
      ) : (
        <>
          <div className="qi-chart">
            <div style={{ height: Math.max(200, churn.buckets.length * 30) }}>
              <canvas ref={chartRef} />
            </div>
          </div>

          <div className="qi-list">
            {churn.buckets.map((b, i) => {
              const isOpen = openBucket === b.name
              return (
                <div key={b.name} className="qi-list-item">
                  <div className="qi-list-head" onClick={() => setOpenBucket(isOpen ? null : b.name)}>
                    <div className="qi-list-name">
                      <span className="qi-dot" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                      {b.name}
                      <span style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 500 }}>
                        {isOpen ? '▼' : '▶'}
                      </span>
                    </div>
                    <span className="qi-list-count">{b.count}건</span>
                  </div>
                  <div style={{ padding: '0 20px 14px' }}>
                    <div className="qi-list-bar">
                      <div
                        className="qi-list-bar-fill"
                        style={{
                          width: `${(b.count / maxCount) * 100}%`,
                          background: CHART_COLORS[i % CHART_COLORS.length],
                        }}
                      />
                    </div>
                  </div>
                  {isOpen && (
                    <div className="qi-list-body">
                      {b.examples.map(ex => (
                        <div key={ex.id} className="qi-example">
                          <div className="qi-example-meta">{ex.created_date?.slice(0, 16)}</div>
                          {ex.reason}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
