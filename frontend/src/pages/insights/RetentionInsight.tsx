// 해지 방어 성과 분석 인사이트 페이지. "이탈·교체 원인 분석" 하위 메뉴 세 번째 항목.
// "해지 방어"(성공) 건수 대 "해지 확정"(실패) 건수로 방어 성공률을 보여주고, 방어 성공 메모에
// 남는 "-성공(<오퍼명>)" 구조화 필드를 집계해 어떤 리텐션 오퍼(과목 전환·기존 학습 유지 등)가
// 가장 많이 쓰였는지 보여준다. 오퍼 카드를 클릭하면 실제 CS 메모 원문을 펼쳐 볼 수 있다.
// 데이터: GET /api/insights/retention (캐시 없이 즉시 집계).
import { useEffect, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import { api, type RetentionStats } from '../../api/client'

const CHART_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#64748b', '#0d9488', '#ec4899', '#14b8a6', '#a855f7', '#eab308']

export default function RetentionInsight() {
  const [stats, setStats] = useState<RetentionStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [openOffer, setOpenOffer] = useState<string | null>(null)

  const gaugeRef = useRef<HTMLCanvasElement>(null)
  const gaugeChart = useRef<Chart | null>(null)
  const chartRef = useRef<HTMLCanvasElement>(null)
  const chart = useRef<Chart | null>(null)

  useEffect(() => {
    setLoading(true)
    api.fetchRetentionStats().then(setStats).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (loading || !stats || !gaugeRef.current) return
    gaugeChart.current?.destroy()
    gaugeChart.current = new Chart(gaugeRef.current, {
      type: 'doughnut',
      data: {
        datasets: [{
          data: [stats.save_rate, Math.max(0, 100 - stats.save_rate)],
          backgroundColor: ['#4f46e5', '#eef0fe'],
          borderWidth: 0,
        }],
      },
      options: { cutout: '76%', plugins: { legend: { display: false }, tooltip: { enabled: false } } },
    })
  }, [loading, stats])

  useEffect(() => {
    if (loading || !stats?.offers.length || !chartRef.current) return
    chart.current?.destroy()
    const top = stats.offers.slice(0, 12)
    chart.current = new Chart(chartRef.current, {
      type: 'bar',
      data: {
        labels: top.map(o => o.name),
        datasets: [{ data: top.map(o => o.count), backgroundColor: CHART_COLORS, borderRadius: 6, borderSkipped: false }],
      },
      options: {
        indexAxis: 'y',
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => `${ctx.parsed.x}건` } },
        },
        scales: {
          x: { grid: { color: '#ebeef5' }, ticks: { color: '#9aa3b5', font: { size: 13 } } },
          y: { grid: { display: false }, ticks: { color: '#1b2440', font: { size: 13 } } },
        },
      },
    })
  }, [loading, stats])

  useEffect(() => () => { gaugeChart.current?.destroy(); chart.current?.destroy() }, [])

  const maxOfferCount = stats?.offers[0]?.count ?? 1
  const labeledCount = stats ? stats.defense_count - stats.unlabeled_count : 0

  return (
    <div className="qi-page">
      <div className="qi-head">
        <div className="qi-icon">🛟</div>
        <div className="qi-head-text">
          <h1>해지 방어 성과</h1>
          <p>
            해지를 시도한 상담 중 얼마나 막아냈는지("해지 방어" vs "해지 확정"), 그리고 방어에 성공한 건 중
            어떤 리텐션 오퍼(과목 전환·기존 학습 유지 등)가 가장 많이 쓰였는지 봐요.
          </p>
        </div>
        <span className="qi-chip">{stats ? `해지 시도 ${(stats.defense_count + stats.confirmed_count).toLocaleString()}건 기준` : '조회 중'}</span>
      </div>

      {loading ? (
        <div className="loading">조회 중...</div>
      ) : !stats || stats.defense_count + stats.confirmed_count === 0 ? (
        <div className="empty">데이터 없음</div>
      ) : (
        <>
          <div className="qi-stats" style={{ gridTemplateColumns: '250px 1fr 1fr' }}>
            <div className="qi-card qi-gauge">
              <div className="qi-gauge-wrap">
                <canvas ref={gaugeRef} />
                <div className="qi-gauge-center">
                  <span className="g-val">{stats.save_rate.toFixed(1)}%</span>
                  <span className="g-label">해지 방어율</span>
                </div>
              </div>
            </div>
            <div className="qi-card qi-stat" style={{ borderLeftColor: 'var(--primary)' }}>
              <div className="s-label" title={`방어 성공 (참고: 해지 확정 ${stats.confirmed_count.toLocaleString()}건 대비)`}>방어 성공 <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--muted)' }}>(참고: 해지 확정 {stats.confirmed_count.toLocaleString()}건 대비)</span></div>
              <div className="s-val" style={{ color: 'var(--primary)' }}>{stats.defense_count.toLocaleString()}건</div>
            </div>
            <div className="qi-card qi-stat" style={{ borderLeftColor: '#94a3b8' }}>
              <div className="s-label" title={`오퍼 필드 확인 가능 (참고: 방어 성공 중 ${((labeledCount / (stats.defense_count || 1)) * 100).toFixed(0)}%, 나머지는 오퍼 미기재)`}>오퍼 필드 확인 가능 <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--muted)' }}>(참고: 방어 성공 중 {((labeledCount / (stats.defense_count || 1)) * 100).toFixed(0)}%, 나머지는 오퍼 미기재)</span></div>
              <div className="s-val" style={{ color: 'var(--text)' }}>{labeledCount.toLocaleString()}건</div>
            </div>
          </div>

          {!stats.offers.length ? (
            <div className="empty">오퍼 데이터 없음</div>
          ) : (
            <>
              <div className="qi-chart">
                <div className="qi-chart-title">리텐션 오퍼별 성공 건수 (상위 12개)</div>
                <div className="qi-chart-sub">해지 방어 메모의 "-성공(오퍼명)" 필드 기준</div>
                <div style={{ height: Math.max(200, Math.min(12, stats.offers.length) * 30) }}>
                  <canvas ref={chartRef} />
                </div>
              </div>

              <div className="qi-list">
                {stats.offers.map((o, i) => {
                  const isOpen = openOffer === o.name
                  return (
                    <div key={o.name} className="qi-list-item">
                      <div className="qi-list-head" onClick={() => setOpenOffer(isOpen ? null : o.name)}>
                        <div className="qi-list-name">
                          <span className="qi-dot" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                          {o.name}
                          <span style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 500 }}>
                            {isOpen ? '▼' : '▶'}
                          </span>
                        </div>
                        <span className="qi-list-count">{o.count}건</span>
                      </div>
                      <div style={{ padding: '0 20px 14px' }}>
                        <div className="qi-list-bar">
                          <div
                            className="qi-list-bar-fill"
                            style={{
                              width: `${(o.count / maxOfferCount) * 100}%`,
                              background: CHART_COLORS[i % CHART_COLORS.length],
                            }}
                          />
                        </div>
                      </div>
                      {isOpen && (
                        <div className="qi-list-body">
                          {o.examples.map(ex => (
                            <div key={ex.id} className="qi-example">
                              <div className="qi-example-meta">{ex.created_date?.slice(0, 16)}</div>
                              {ex.memo.split('\n').map((line, li) => (
                                <span key={li}>{li > 0 && <br />}{line}</span>
                              ))}
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
        </>
      )}
    </div>
  )
}
