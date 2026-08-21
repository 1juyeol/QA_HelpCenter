// 기기 교체 분석 인사이트 페이지. "이탈·교체 원인 분석" 하위 메뉴 중 기기 교체 쪽 절반.
// "기기 교체 요청" 전체 건을 기종별로 묶고, 선출고(먼저 보내고 나중에 회수)인지
// 단순교체(회수 후 교체)인지 비율을 함께 보여준다. 카드를 클릭하면 실제 CS 메모의
// 확인사항·증상 원문을 펼쳐서 확인할 수 있다.
// 데이터: GET /api/insights/device_swaps (캐시 없이 즉시 집계).
import { useEffect, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import { api, type DeviceSwapStats } from '../../api/client'

const CHART_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#64748b', '#0d9488']

export default function DeviceSwapInsight() {
  const [devices, setDevices] = useState<DeviceSwapStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [openModel, setOpenModel] = useState<string | null>(null)

  const chartRef = useRef<HTMLCanvasElement>(null)
  const chart = useRef<Chart | null>(null)

  useEffect(() => {
    setLoading(true)
    api.fetchDeviceSwaps().then(setDevices).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (loading || !devices?.models.length || !chartRef.current) return
    chart.current?.destroy()
    const top = devices.models.slice(0, 8)
    chart.current = new Chart(chartRef.current, {
      type: 'bar',
      data: {
        labels: top.map(m => m.model),
        datasets: [{ data: top.map(m => m.count), backgroundColor: CHART_COLORS, borderRadius: 6, borderSkipped: false }],
      },
      options: {
        indexAxis: 'y',
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => `${ctx.parsed.x}건` } },
        },
        scales: {
          x: { grid: { color: '#ebeef5' }, ticks: { color: '#9aa3b5', font: { size: 11 } } },
          y: { grid: { display: false }, ticks: { color: '#1b2440', font: { size: 12 } } },
        },
      },
    })
  }, [loading, devices])

  useEffect(() => () => { chart.current?.destroy() }, [])

  const maxCount = devices?.models[0]?.count ?? 1

  return (
    <div className="qi-page">
      <div className="qi-head">
        <div className="qi-icon">📦</div>
        <div className="qi-head-text">
          <h1>기기 교체 분석</h1>
          <p>
            "기기 교체 요청" 전체 건을 기종별로 묶고, 선출고(먼저 보내고 나중에 회수)와
            단순교체(회수 후 교체) 비율을 함께 봐요.
          </p>
        </div>
        <span className="qi-chip">{devices ? `전체 ${devices.total.toLocaleString()}건 기준` : '조회 중'}</span>
      </div>

      {loading ? (
        <div className="loading">조회 중...</div>
      ) : !devices?.total ? (
        <div className="empty">데이터 없음</div>
      ) : (
        <>
          <div className="qi-stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="qi-card qi-stat">
              <div className="s-label">총 교체 요청</div>
              <div className="s-val">{devices.total.toLocaleString()}건</div>
            </div>
            <div className="qi-card qi-stat">
              <div className="s-label">선출고</div>
              <div className="s-val" style={{ color: 'var(--primary)' }}>
                {((devices.seonchulgo_count / devices.total) * 100).toFixed(1)}%
              </div>
              <div className="s-sub">{devices.seonchulgo_count.toLocaleString()}건</div>
            </div>
            <div className="qi-card qi-stat">
              <div className="s-label">단순교체(회수 후 교체)</div>
              <div className="s-val" style={{ color: 'var(--muted)' }}>
                {((devices.normal_count / devices.total) * 100).toFixed(1)}%
              </div>
              <div className="s-sub">{devices.normal_count.toLocaleString()}건</div>
            </div>
          </div>

          <div className="qi-chart">
            <div className="qi-chart-title">기종별 교체 건수 (상위 8개)</div>
            <div style={{ height: Math.max(200, Math.min(8, devices.models.length) * 34), marginTop: 12 }}>
              <canvas ref={chartRef} />
            </div>
          </div>

          <div className="qi-list">
            {devices.models.map((m, i) => {
              const isOpen = openModel === m.model
              const seonchulgoInModel = m.examples.filter(e => e.seonchulgo).length
              return (
                <div key={m.model} className="qi-list-item">
                  <div className="qi-list-head" onClick={() => setOpenModel(isOpen ? null : m.model)}>
                    <div className="qi-list-name">
                      <span className="qi-dot" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                      {m.model}
                      <span style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 500 }}>
                        {isOpen ? '▼' : '▶'}
                      </span>
                    </div>
                    <span className="qi-list-count">{m.count}건</span>
                  </div>
                  <div style={{ padding: '0 20px 14px' }}>
                    <div className="qi-list-bar">
                      <div
                        className="qi-list-bar-fill"
                        style={{
                          width: `${(m.count / maxCount) * 100}%`,
                          background: CHART_COLORS[i % CHART_COLORS.length],
                        }}
                      />
                    </div>
                  </div>
                  {isOpen && (
                    <div className="qi-list-body">
                      <div style={{ fontSize: 11, color: 'var(--faint)', padding: '10px 0 6px' }}>
                        이 기종 중 선출고 {seonchulgoInModel}건 · 단순교체 {m.examples.length - seonchulgoInModel}건 (표시된 예시 기준)
                      </div>
                      {m.examples.map(ex => (
                        <div key={ex.id} className="qi-example">
                          <div className="qi-example-meta">
                            {ex.created_date?.slice(0, 16)}
                            <span className={`qi-example-tag${ex.seonchulgo ? ' on' : ''}`}>
                              {ex.seonchulgo ? '선출고' : '단순교체'}
                            </span>
                          </div>
                          {ex.reason || '(증상 텍스트 없음)'}
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
