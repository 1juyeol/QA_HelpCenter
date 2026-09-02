// 인사이트 페이지 공용 컴포넌트·헬퍼 모음.
// makeLineChartConfig : SQI·언어 온도 페이지의 주간 꺾은선 차트 설정을 생성한다.
//   기준선(baseline)을 초과한 주는 점·선을 빨간색으로 강조하고, 기준선은 점선으로 함께 그린다.
// KpiCard : "이번 주 값 vs 기준선" 비교를 보여주는 KPI 박스 컴포넌트.
// 서비스 품질 지수(ServiceQualityIndex)·고객 언어 온도(LanguageTemperature) 페이지가 공통으로 사용한다.

export function makeLineChartConfig(
  data: number[],
  labels: string[],
  baseline: number,
  lineColor: string,
  datasetLabel: string,
) {
  return {
    type: 'line' as const,
    data: {
      labels,
      datasets: [
        {
          label: datasetLabel,
          data,
          borderColor: lineColor,
          backgroundColor: 'transparent',
          pointBackgroundColor: data.map(v => v > baseline ? '#ef4444' : lineColor),
          pointRadius: 5,
          tension: 0.3,
          segment: {
            borderColor: (ctx: any) => (data[ctx.p1DataIndex] ?? 0) > baseline ? '#ef4444' : lineColor,
          },
        },
        {
          label: `기준선 (${baseline.toFixed(1)}%)`,
          data: labels.map(() => parseFloat(baseline.toFixed(1))),
          borderColor: '#94a3b8',
          borderDash: [6, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          backgroundColor: 'transparent',
        },
      ],
    },
    options: {
      plugins: {
        legend: { position: 'bottom' as const, labels: { boxWidth: 12, font: { size: 17 } } },
        tooltip: { callbacks: { label: (ctx: any) => `${ctx.dataset.label}: ${ctx.parsed.y}%` } },
      },
      scales: {
        y: { min: 0, ticks: { callback: (v: any) => `${v}%`, font: { size: 13 } } },
        x: { ticks: { font: { size: 13 } } },
      },
    },
  }
}

export function KpiCard({ label, value, baseline }: { label: string; value: number; baseline: number }) {
  const isHigh = value > baseline
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ background: '#f8fafc', borderRadius: 12, padding: '20px 28px', border: '1px solid #e2e8f0', display: 'inline-block', minWidth: 160 }}>
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>{label}</div>
        <div style={{ fontSize: 32, fontWeight: 700, color: isHigh ? '#ef4444' : '#0f172a' }}>
          {value.toFixed(1)}%
        </div>
        <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
          기준 {baseline.toFixed(1)}% 대비{' '}
          <span style={{ color: isHigh ? '#ef4444' : '#10b981', fontWeight: 600 }}>
            {isHigh
              ? `▲ ${(value - baseline).toFixed(1)}%p`
              : `▼ ${(baseline - value).toFixed(1)}%p`}
          </span>
        </div>
      </div>
    </div>
  )
}
