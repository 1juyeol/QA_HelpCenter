// "반복 Wings 티켓" 페이지 안에 별도 섹션으로 붙는 "가정별 이탈 위험" 뷰.
// Wings 티켓 하나는 한 가정의 개별 A/S 건이라(여러 고객이 공유하지 않음), 같은 티켓이 상담
// 메모에 여러 번 언급됐다는 건 "그 가정이 이 문제 하나로 상담을 여러 번 거쳤는데도 아직
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
// 상담건수 내림차순 정렬이라 가장 심각한 케이스가 이미 맨 위에 온다)에서만 다룬다.
//
// rows는 부모(WingsTickets.tsx)가 이미 fetch한 걸 그대로 받는다 — 같은 /api/insights/wings_tickets
// 데이터를 이 섹션이 또 fetch할 이유가 없다.
//
// 주간 추이 차트의 막대를 클릭하면 그 카테고리·주에 해당하는 티켓 목록을 모달로 보여준다.
// 별도 API 호출 없이 이미 갖고 있는 rows를 그 자리에서 필터링한다 — DailyReport의
// CategoryMemoModal은 재사용하지 않았는데, 그건 categoryMain+날짜만으로 /api/issues를
// 새로 조회해 "그 기간 그 카테고리의 모든 상담"을 가져오는 방식이라 여기서 보여주려는
// "그 주에 처음 상담에 등장한 반복 Wings 티켓"이라는 좁은 조건과 데이터 자체가 다르다.
import { useEffect, useMemo, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import { adminStudentUrl, adminParentUrl, type InsightWings } from '../../api/client'

// 대분류(해지·유지 상담/기기·하드웨어 오류/교재·물류·배송/네트워크·앱 오류/미납·결제/체험 관련/
// 계정·서비스/윙크북스/기타) 9개 + 미분류까지 최대 10개가 동시에 나타날 수 있어 10색 준비 —
// 이전엔 7색이라 인덱스가 7 이상으로 넘어가면 색이 겹쳐서 범례에서 서로 다른 카테고리를
// 구분할 수 없었다.
const CATEGORY_COLORS = [
  '#ef4444', '#3b82f6', '#f59e0b', '#8b5cf6', '#10b981',
  '#ec4899', '#64748b', '#06b6d4', '#a16207', '#6366f1',
]

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

// "8월 3주차" 형식 라벨. 운영 현황(Dashboard.tsx)의 monthWeekLabel과 동일한 방식 — 그 주
// 목요일이 속한 달을 기준 월로 삼고, 그 달 1일이 속한 주를 1주차로 센다.
function monthWeekLabel(mondayStr: string): string {
  const monday = new Date(mondayStr + 'T00:00:00Z')
  const thursday = new Date(monday); thursday.setUTCDate(thursday.getUTCDate() + 3)
  const anchorYear = thursday.getUTCFullYear(), anchorMonth = thursday.getUTCMonth()
  const firstOfMonth = new Date(Date.UTC(anchorYear, anchorMonth, 1))
  const firstMonday = new Date(firstOfMonth)
  firstMonday.setUTCDate(firstMonday.getUTCDate() - ((firstOfMonth.getUTCDay() + 6) % 7))
  const weekNo = Math.round((monday.getTime() - firstMonday.getTime()) / (7 * 86400000)) + 1
  return `${anchorMonth + 1}월 ${weekNo}주차`
}

function getDiffDays(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr.replace(' ', 'T')).getTime()) / 86400000)
}

export default function CaseRiskSection({ rows }: { rows: InsightWings[] }) {
  const chartCanvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const [modalSel, setModalSel] = useState<{ category: string; week: string } | null>(null)

  useEffect(() => {
    if (!modalSel) return
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setModalSel(null) }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [modalSel])

  // 최근 3개월(12주)치만 본다 — rows 자체는 180일치를 받아오지만, 이 섹션은 최근 추이 파악이
  // 목적이라 그보다 오래된 케이스까지 매주 다 그리면 차트가 너무 길어지고 최근 추이를 읽기 어렵다.
  const recentRows = useMemo(() => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 84)
    return rows.filter(r => new Date(r.first_date.replace(' ', 'T')) >= cutoff)
  }, [rows])

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of recentRows) {
      const key = r.category ?? '미분류'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [recentRows])

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
    for (const r of recentRows) {
      const week = weekStartOf(r.first_date)
      const cat = r.category ?? '미분류'
      weeks.add(week)
      if (!byWeekCategory.has(week)) byWeekCategory.set(week, new Map())
      const catMap = byWeekCategory.get(week)!
      catMap.set(cat, (catMap.get(cat) ?? 0) + 1)
    }
    const sortedWeeks = [...weeks].sort()
    return { weeks: sortedWeeks, byWeekCategory }
  }, [recentRows])

  useEffect(() => {
    if (!chartCanvasRef.current) return
    chartRef.current?.destroy()
    if (weeklyMatrix.weeks.length === 0) return

    const categories = categoryCounts.map(([cat]) => cat)
    chartRef.current = new Chart(chartCanvasRef.current, {
      type: 'bar',
      data: {
        labels: weeklyMatrix.weeks.map(monthWeekLabel),
        datasets: categories.map(cat => ({
          label: cat,
          data: weeklyMatrix.weeks.map(w => weeklyMatrix.byWeekCategory.get(w)?.get(cat) ?? 0),
          backgroundColor: categoryColor.get(cat),
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (_e, elements) => {
          if (elements.length === 0) return
          const { datasetIndex, index } = elements[0]
          const week = weeklyMatrix.weeks[index]
          const category = categories[datasetIndex]
          if (week && category) setModalSel({ category, week })
        },
        onHover: (ev, elements) => {
          const t = (ev.native?.target as HTMLElement) ?? undefined
          if (t) t.style.cursor = elements.length ? 'pointer' : 'default'
        },
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 17 }, boxWidth: 12 } },
          tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${Number(ctx.raw).toLocaleString()}건` } },
        },
        scales: {
          x: { stacked: true, ticks: { font: { size: 13 } } },
          y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1, font: { size: 13 } } },
        },
      },
    })
    return () => { chartRef.current?.destroy() }
  }, [weeklyMatrix, categoryCounts, categoryColor])

  const matchingTickets = useMemo(() => {
    if (!modalSel) return []
    return recentRows.filter(r => (r.category ?? '미분류') === modalSel.category && weekStartOf(r.first_date) === modalSel.week)
  }, [modalSel, recentRows])

  return (
    <div style={{ marginTop: 28 }}>
      <div className="section-card" style={{ borderLeft: '4px solid #ef4444' }}>
        {recentRows.length === 0 ? (
          <div className="empty">해당 기간에 반복 미해결 케이스 없음</div>
        ) : (
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#1e293b', marginBottom: 4 }}>카테고리별 주간 추이</div>
            <div style={{ fontSize: 15, color: '#334155', marginBottom: 10 }}>막대를 클릭하면 해당 티켓 목록을 확인할 수 있습니다.</div>
            <div style={{ height: 220 }}>
              <canvas ref={chartCanvasRef} />
            </div>
          </div>
        )}
      </div>
      {modalSel && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 24,
          }}
          onClick={e => { if (e.target === e.currentTarget) setModalSel(null) }}
        >
          <div style={{
            background: '#fff', borderRadius: 16,
            width: '100%', maxWidth: 960, maxHeight: '90vh',
            display: 'flex', flexDirection: 'column',
            boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
            overflow: 'hidden',
          }}>
            <div style={{
              padding: '18px 32px', borderBottom: '1px solid #e2e8f0',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
            }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#1e293b' }}>{modalSel.category}</div>
                <div style={{ marginTop: 4, fontSize: 15, color: '#475569', fontWeight: 500 }}>
                  {monthWeekLabel(modalSel.week)} 최초 상담 · 총 {matchingTickets.length.toLocaleString()}건
                </div>
              </div>
              <button
                onClick={() => setModalSel(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#94a3b8', lineHeight: 1, padding: 4 }}
              >✕</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                  <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                    {['티켓 번호', '학생번호', '학부모번호', '상담 건수', '경과일', '관리상태', '최근 메모'].map(h => (
                      <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 16, fontWeight: 700, color: '#64748b', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matchingTickets.map(r => (
                    <tr key={r.ticket_id} style={{ borderBottom: '1px solid #f8fafc' }}>
                      <td style={{ padding: '9px 12px', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                        <a href={`https://wings.danbiedu.co.kr/#ticket/zoom/${r.ticket_id}`} target="_blank" rel="noreferrer" style={{ color: '#1a56db', fontWeight: 600, textDecoration: 'none' }}>
                          #{r.ticket_id}
                        </a>
                      </td>
                      <td style={{ padding: '9px 12px', fontSize: 15, verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                        {r.student_id
                          ? <a href={adminStudentUrl(r.student_id)} target="_blank" rel="noreferrer" style={{ color: '#1a56db', textDecoration: 'none' }}>{r.student_id}</a>
                          : <span style={{ color: '#374151' }}>—</span>}
                      </td>
                      <td style={{ padding: '9px 12px', fontSize: 15, verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                        {r.parent_id
                          ? <a href={adminParentUrl(String(r.parent_id))} target="_blank" rel="noreferrer" style={{ color: '#1a56db', textDecoration: 'none' }}>{r.parent_id}</a>
                          : <span style={{ color: '#374151' }}>—</span>}
                      </td>
                      <td style={{ padding: '9px 12px', fontSize: 15, verticalAlign: 'top' }}>{r.cs_count}건</td>
                      <td style={{ padding: '9px 12px', fontSize: 15, verticalAlign: 'top', whiteSpace: 'nowrap' }}>{getDiffDays(r.first_date)}일</td>
                      <td style={{ padding: '9px 12px', fontSize: 15, verticalAlign: 'top', whiteSpace: 'nowrap', color: '#374151' }}>{r.state ?? '조회 안됨'}</td>
                      <td style={{ padding: '9px 12px', fontSize: 15, color: '#374151', lineHeight: 1.6, verticalAlign: 'top' }}>
                        {r.memos?.[0]?.memo
                          ? r.memos[0].memo.split('\n').map((line, i) => <span key={i}>{i > 0 && <br />}{line}</span>)
                          : <span style={{ color: '#cbd5e1' }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
