// "반복 Wings 티켓" 페이지 안에 별도 섹션으로 붙는 "가정별 이탈 위험" 뷰.
// Wings 티켓 하나는 한 가정의 개별 A/S 건이라(여러 고객이 공유하지 않음), 같은 티켓이 CS
// 메모에 여러 번 언급됐다는 건 "그 가정이 이 문제 하나로 CS를 여러 번 거쳤는데도 아직
// 안 풀렸다"는 뜻이다 — 위쪽 원래 표(버그 내용 확인용)와 같은 데이터(InsightWings[])를
// 그대로 쓰지만, 이 섹션은 그 데이터를 "카테고리별로 얼마나 쌓여있고 줄고 있는지" 시간
// 축으로 집계해서 보여주는 게 목적이다.
//
// 카테고리별 분포(막대) 차트는 만들었다가 뺐다 — 지금 표본이 8건 안팎이고 앞으로도 크게
// 늘어날 데이터가 아니라서(늘어나면 그 자체가 문제), 주간 추이 차트의 카테고리별 막대를
// 다 더하면 나오는 숫자라 따로 둘 실익이 없었다.
//
// "주간보고서 미리보기" 박스(신규/방치 건수 카드 + 문장)는 여기서 만들어보고 톤을 다듬은 뒤
// 실제 주간보고서(WeeklyReport.tsx의 "반복 Wings 티켓" 섹션, report_weekly.py의
// _wings_repeat_counts)로 옮겼다 — 이 페이지에 그대로 두면 같은 내용이 두 군데(인사이트
// 미리보기·실제 보고서)에 남아 헷갈리므로 여기서는 뺐다.
//
// 특정 학부모를 짚는 내용(가장 오래된 사례 등 개별 케이스)은 주간보고서에 넣지 않는다 —
// "특정 인원이 문제"라는 식의 내용은 아래 원래 표(개별 케이스 조회용, 기본적으로
// CS건수 내림차순 정렬이라 가장 심각한 케이스가 이미 맨 위에 온다)에서만 다룬다.
//
// rows는 부모(WingsTickets.tsx)가 이미 fetch한 걸 그대로 받는다 — 같은 /api/insights/wings_tickets
// 데이터를 이 섹션이 또 fetch할 이유가 없다.
import { useEffect, useMemo, useRef } from 'react'
import Chart from 'chart.js/auto'
import type { InsightWings } from '../../api/client'

const CATEGORY_COLORS = ['#ef4444', '#3b82f6', '#f59e0b', '#8b5cf6', '#10b981', '#ec4899', '#64748b']

// toISOString()으로 변환하면 자정 근처 날짜가 UTC 기준으로 하루 밀리므로 로컬 날짜
// 구성요소로 직접 조립한다.
function toLocalDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// first_date가 속한 주의 월요일(KST 기준 문자열 그대로 파싱) — 주간 추이 x축 버킷 키로 쓴다.
function weekStartOf(dateStr: string): string {
  const d = new Date(dateStr.replace(' ', 'T'))
  const day = d.getDay()
  const diffToMonday = day === 0 ? 6 : day - 1
  d.setDate(d.getDate() - diffToMonday)
  return toLocalDateString(d)
}

export default function CaseRiskSection({ rows }: { rows: InsightWings[] }) {
  const chartCanvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of rows) {
      const key = r.category ?? '미분류'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])

  const categoryColor = useMemo(() => {
    const map = new Map<string, string>()
    categoryCounts.forEach(([cat], i) => map.set(cat, CATEGORY_COLORS[i % CATEGORY_COLORS.length]))
    return map
  }, [categoryCounts])

  // 주(월요일) × 카테고리 매트릭스. 주는 오름차순(과거→최근)으로 정렬해 추이를 왼쪽에서
  // 오른쪽으로 읽히게 한다.
  const weeklyMatrix = useMemo(() => {
    const weeks = new Set<string>()
    const byWeekCategory = new Map<string, Map<string, number>>()
    for (const r of rows) {
      const week = weekStartOf(r.first_date)
      const cat = r.category ?? '미분류'
      weeks.add(week)
      if (!byWeekCategory.has(week)) byWeekCategory.set(week, new Map())
      const catMap = byWeekCategory.get(week)!
      catMap.set(cat, (catMap.get(cat) ?? 0) + 1)
    }
    const sortedWeeks = [...weeks].sort()
    return { weeks: sortedWeeks, byWeekCategory }
  }, [rows])

  useEffect(() => {
    if (!chartCanvasRef.current) return
    chartRef.current?.destroy()
    if (weeklyMatrix.weeks.length === 0) return

    const categories = categoryCounts.map(([cat]) => cat)
    chartRef.current = new Chart(chartCanvasRef.current, {
      type: 'bar',
      data: {
        labels: weeklyMatrix.weeks.map(w => `${w} 주`),
        datasets: categories.map(cat => ({
          label: cat,
          data: weeklyMatrix.weeks.map(w => weeklyMatrix.byWeekCategory.get(w)?.get(cat) ?? 0),
          backgroundColor: categoryColor.get(cat),
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 17 }, boxWidth: 12 } },
          tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw}건` } },
        },
        scales: {
          x: { stacked: true, ticks: { font: { size: 13 } } },
          y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1, font: { size: 13 } } },
        },
      },
    })
    return () => { chartRef.current?.destroy() }
  }, [weeklyMatrix, categoryCounts, categoryColor])

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, marginBottom: 4, fontSize: 18, fontWeight: 700, color: '#1e293b' }}>가정별 이탈 위험</h2>
        <p style={{ margin: 0, fontSize: 15, color: '#64748b', lineHeight: 1.6 }}>
          위 표와 같은 케이스를 카테고리·시간 기준으로 다시 봅니다 — 어떤 유형에서 장기
          미해결이 몰리는지, 그게 줄고 있는지 늘고 있는지 확인하기 위한 뷰입니다.
        </p>
      </div>

      <div className="section-card" style={{ borderLeft: '4px solid #ef4444' }}>
        {rows.length === 0 ? (
          <div className="empty">해당 기간에 반복 미해결 케이스 없음</div>
        ) : (
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#1e293b', marginBottom: 10 }}>카테고리별 주간 추이</div>
            <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10 }}>각 케이스가 처음 반복 언급된(first_date) 주 기준. 특정 카테고리가 줄지 않고 쌓이면 위험 신호입니다.</div>
            <div style={{ height: 220 }}>
              <canvas ref={chartCanvasRef} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
