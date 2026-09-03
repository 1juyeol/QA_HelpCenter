// 서비스 품질 지수(SQI) 인사이트 페이지. (일별, 주말·공휴일 제외)
// SQI = ALLOWED 카테고리(기기·앱 오류, 해지, 미납 등 회사 비용 발생 상담) 건수 ÷ 전체 상담 건수 × 100.
// 레이아웃: 헤더 → 원형 게이지(최근 SQI) + KPI 타일 2개(최근·최고일) → 일별 추이 차트 → 집계 기준.
// 색은 인디고+무채색으로 절제. 데이터·계산은 useSqiData.ts(category_daily 기반).
import { useEffect, useRef } from 'react'
import Chart from 'chart.js/auto'
import { FILTER_TREE } from '../../api/categories'
import { makeLineChartConfig } from './insightsShared'
import { useSqiData } from './useSqiData'

export default function ServiceQualityIndex() {
  const { loading, points, latest, baseline, isHigh, peak } = useSqiData()
  const lineRef = useRef<HTMLCanvasElement>(null)
  const lineChart = useRef<Chart | null>(null)
  const gaugeRef = useRef<HTMLCanvasElement>(null)
  const gaugeChart = useRef<Chart | null>(null)

  useEffect(() => {
    if (loading || !points.length || !lineRef.current || baseline == null) return
    lineChart.current?.destroy()
    lineChart.current = new Chart(
      lineRef.current,
      makeLineChartConfig(points.map(p => p.sqi), points.map(p => p.label), baseline, '#4f46e5', 'SQI'),
    )
  }, [loading, points])

  useEffect(() => {
    if (loading || !latest || !gaugeRef.current) return
    gaugeChart.current?.destroy()
    gaugeChart.current = new Chart(gaugeRef.current, {
      type: 'doughnut',
      data: { datasets: [{ data: [latest.sqi, Math.max(0, 100 - latest.sqi)], backgroundColor: [isHigh ? '#ef4444' : '#4f46e5', '#eef0fe'], borderWidth: 0 }] },
      options: { cutout: '76%', plugins: { legend: { display: false }, tooltip: { enabled: false } } },
    })
  }, [loading, points])

  useEffect(() => () => { lineChart.current?.destroy(); gaugeChart.current?.destroy() }, [])

  return (
    <div className="qi-page">
      <div className="qi-head">
        <div className="qi-icon">🛡️</div>
        <div className="qi-head-text">
          <h1>서비스 품질 지수</h1>
          <p>비용 발생 상담 비중 지표입니다(기기·앱 오류, 해지, 미납 등 포함). 높을수록 부담이 크다는 신호이며, 주말·공휴일은 집계에서 제외합니다.</p>
        </div>
        <span className="qi-chip">최근 1달 · 일별</span>
      </div>

      {loading ? (
        <div className="loading">조회 중...</div>
      ) : !points.length || baseline == null || !latest ? (
        <div className="empty">데이터 없음</div>
      ) : (
        <>
          <div className="qi-stats" style={{ gridTemplateColumns: '250px 1fr 1fr' }}>
            <div className="qi-card qi-gauge">
              <div className="qi-gauge-wrap">
                <canvas ref={gaugeRef} />
                <div className="qi-gauge-center">
                  <span className={`g-val${isHigh ? ' high' : ''}`}>{latest.sqi.toFixed(1)}%</span>
                  <span className="g-label">최근 SQI</span>
                </div>
              </div>
            </div>
            <div className="qi-card qi-stat" style={{ borderLeftColor: isHigh ? 'var(--danger)' : 'var(--primary)' }}>
              <div className="s-label" title={`${latest.label} (최근) (참고: 기준 ${baseline.toFixed(1)}% 대비 ${isHigh ? `▲ ${(latest.sqi - baseline).toFixed(1)}%p` : `▼ ${(baseline - latest.sqi).toFixed(1)}%p`})`}>{latest.label} (최근) <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--muted)' }}>(참고: 기준 {baseline.toFixed(1)}% 대비 {isHigh ? `▲ ${(latest.sqi - baseline).toFixed(1)}%p` : `▼ ${(baseline - latest.sqi).toFixed(1)}%p`})</span></div>
              <div className="s-val" style={{ color: isHigh ? 'var(--danger)' : 'var(--primary)' }}>{latest.sqi.toFixed(1)}%</div>
            </div>
            <div className="qi-card qi-stat" style={{ borderLeftColor: '#94a3b8' }}>
              <div className="s-label" title={`최고일 (참고: ${peak ? peak.label : '—'})`}>최고일 <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--muted)' }}>(참고: {peak ? peak.label : '—'})</span></div>
              <div className="s-val" style={{ color: 'var(--text)' }}>{peak ? peak.sqi.toFixed(1) : '0'}%</div>
            </div>
          </div>

          <div className="qi-chart">
            <div className="qi-chart-title">일별 추이</div>
            <div className="qi-chart-sub">기준선(초반 평균)을 넘은 날은 빨간색 (상담 0건인 날·주말·공휴일 제외)</div>
            <canvas ref={lineRef} />
          </div>

          <div className="qi-crit">
            <div className="qi-crit-title">집계 기준 카테고리</div>
            {FILTER_TREE.map(({ main, subs }) => (
              <div key={main} className="qi-crit-row">
                <span className="qi-crit-main">{main}</span>
                <div className="qi-pills">
                  {subs.map(sub => <span key={sub} className="qi-pill">{sub}</span>)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
