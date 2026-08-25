// 기기 교체 분석 인사이트 페이지. "이탈·교체 원인 분석" 하위 메뉴 중 기기 교체 쪽 절반.
// "기기 교체 요청" 전체 건을 1) 왜 교체됐는지(사유), 2) 기종별로 각각 묶어서 보여준다.
// 사유는 다시 "사유 명확"(하드웨어 결함·정상적인 상품 전환 — 그대로 둬도 되는 것)과
// "확인 필요"(이력 없음·사유 불명확·고객 요청형·학습 동기부여용 — 고장이 아닌데 비용이
// 나간 것으로 의심되는 것)로 나눈다. 후자가 비용 절감 관점에서 실제로 봐야 할 대상이라
// 기본으로 펼쳐두고, 전자는 궁금할 때만 펼쳐보게 접어둔다 (tier 판정은 백엔드
// device_swap_reason_tier()가 한다 — 프론트에서 카테고리명으로 다시 판단하지 않는다).
// 기종 카드를 클릭하면 실제 CS 메모의 확인사항·증상 원문을 펼쳐서 확인할 수 있다.
// 데이터: GET /api/insights/device_swaps (캐시 없이 즉시 집계).
import { useEffect, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import { api, type DeviceSwapStats } from '../../api/client'

const CHART_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#64748b', '#0d9488']

export default function DeviceSwapInsight() {
  const [devices, setDevices] = useState<DeviceSwapStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [openModel, setOpenModel] = useState<string | null>(null)
  const [openReason, setOpenReason] = useState<string | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const [modelsOpen, setModelsOpen] = useState(false)

  const chartRef = useRef<HTMLCanvasElement>(null)
  const chart = useRef<Chart | null>(null)

  useEffect(() => {
    setLoading(true)
    api.fetchDeviceSwaps().then(setDevices).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (loading || !devices?.models.length || !modelsOpen || !chartRef.current) return
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
  }, [loading, devices, modelsOpen])

  useEffect(() => () => { chart.current?.destroy() }, [])

  const maxCount = devices?.models[0]?.count ?? 1
  const reasons = devices?.reasons ?? []
  const reviewReasons = reasons.filter(r => r.tier === 'needs_review')
  const clearReasons = reasons.filter(r => r.tier === 'clear')
  const reviewCount = reviewReasons.reduce((sum, r) => sum + r.count, 0)
  const clearCount = clearReasons.reduce((sum, r) => sum + r.count, 0)
  const reasonTotal = reviewCount + clearCount
  const maxReasonCount = reasons[0]?.count ?? 1

  return (
    <div className="qi-page">
      <div className="qi-head">
        <div className="qi-icon">📦</div>
        <div className="qi-head-text">
          <h1>기기 교체 분석</h1>
          <p>
            "기기 교체 요청" 전체 건을 왜 교체됐는지(사유)와 기종별로 나눠서 봐요.
            사유 중 고장이 아닌데 바뀐 것·이력이 없는 것만 따로 모아 비용 절감 관점에서
            검토할 수 있게 했어요.
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

          {reasonTotal > 0 && (
            <>
              <div className="qi-stats" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                <div className="qi-card qi-stat">
                  <div className="s-label">사유 명확 (하드웨어 결함·정상 상품 전환)</div>
                  <div className="s-val" style={{ color: 'var(--muted)' }}>
                    {((clearCount / reasonTotal) * 100).toFixed(1)}%
                  </div>
                  <div className="s-sub">{clearCount.toLocaleString()}건</div>
                </div>
                <div className="qi-card qi-stat">
                  <div className="s-label">확인 필요 (고장 아님·이력 없음·사유 불명확)</div>
                  <div className="s-val" style={{ color: 'var(--danger)' }}>
                    {((reviewCount / reasonTotal) * 100).toFixed(1)}%
                  </div>
                  <div className="s-sub">{reviewCount.toLocaleString()}건</div>
                </div>
              </div>

              <div className="qi-section-title">🔎 확인 필요 — 고장 아닌데 교체됐거나 사유가 불분명한 건</div>
              <p className="qi-section-sub">
                이 중 상당수가 실제로는 방지 가능한 비용일 수 있습니다. 카드를 눌러 실제 CS 메모를 확인하세요.
              </p>
              <div className="qi-list">
                {reviewReasons.map(r => {
                  const isOpen = openReason === r.name
                  return (
                    <div key={r.name} className="qi-list-item">
                      <div className="qi-list-head" onClick={() => setOpenReason(isOpen ? null : r.name)}>
                        <div className="qi-list-name">
                          <span className="qi-dot" style={{ background: 'var(--danger)' }} />
                          {r.name}
                          <span style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 500 }}>
                            {isOpen ? '▼' : '▶'}
                          </span>
                        </div>
                        <span className="qi-list-count" style={{ color: 'var(--danger)', background: '#fef2f2' }}>
                          {r.count.toLocaleString()}건
                        </span>
                      </div>
                      <div style={{ padding: '0 20px 14px' }}>
                        <div className="qi-list-bar">
                          <div
                            className="qi-list-bar-fill"
                            style={{ width: `${(r.count / maxReasonCount) * 100}%`, background: 'var(--danger)' }}
                          />
                        </div>
                      </div>
                      {isOpen && (
                        <div className="qi-list-body">
                          {r.examples.map(ex => (
                            <div key={ex.id} className="qi-example">
                              <div className="qi-example-meta">{ex.created_date?.slice(0, 16)}</div>
                              {ex.reason || '(증상 텍스트 없음)'}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div
                className="qi-section-title"
                style={{ cursor: 'pointer', userSelect: 'none' }}
                onClick={() => setClearOpen(!clearOpen)}
              >
                ✅ 사유 명확 상세 {clearOpen ? '▼' : '▶'}
              </div>
              {clearOpen && (
                <div className="qi-list">
                  {clearReasons.map(r => {
                    const isOpen = openReason === r.name
                    return (
                      <div key={r.name} className="qi-list-item">
                        <div className="qi-list-head" onClick={() => setOpenReason(isOpen ? null : r.name)}>
                          <div className="qi-list-name">
                            <span className="qi-dot" style={{ background: 'var(--primary)' }} />
                            {r.name}
                            <span style={{ fontSize: 11, color: 'var(--faint)', fontWeight: 500 }}>
                              {isOpen ? '▼' : '▶'}
                            </span>
                          </div>
                          <span className="qi-list-count">{r.count.toLocaleString()}건</span>
                        </div>
                        <div style={{ padding: '0 20px 14px' }}>
                          <div className="qi-list-bar">
                            <div
                              className="qi-list-bar-fill"
                              style={{ width: `${(r.count / maxReasonCount) * 100}%` }}
                            />
                          </div>
                        </div>
                        {isOpen && (
                          <div className="qi-list-body">
                            {r.examples.map(ex => (
                              <div key={ex.id} className="qi-example">
                                <div className="qi-example-meta">{ex.created_date?.slice(0, 16)}</div>
                                {ex.reason || '(증상 텍스트 없음)'}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}

          <div
            className="qi-section-title"
            style={{ cursor: 'pointer', userSelect: 'none' }}
            onClick={() => setModelsOpen(!modelsOpen)}
          >
            📦 기종별 교체 건수 상세 {modelsOpen ? '▼' : '▶'}
          </div>
          <p className="qi-section-sub">
            어떤 기종이 나갔는지보다 왜 교체됐는지가 더 중요해서 기본은 접어뒀습니다.
          </p>
          {modelsOpen && (
          <>
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
        </>
      )}
    </div>
  )
}
