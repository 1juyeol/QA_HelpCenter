// 메인 대시보드 페이지. 이 파일 하나에 대시보드의 모든 UI와 상태 관리가 집중되어 있다.
// 주요 기능: 시간대별·일별·주별·월별 탭 전환 / KPI 카드(동시간대 대비·평균 대비) /
// Chart.js 차트(Bar·Line) / 카테고리 드릴다운(대분류→소분류→메모 목록) /
// 피크 시간대 하이라이트 / 정시·30분 자동 리로드.
// 데이터 흐름: api/client.ts 함수 호출 → 상태 업데이트 → Chart.js 재렌더링 → DOM 반영.
import { useEffect, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import { api, adminStudentUrl, adminParentUrl, type BucketRow, type CategoryRow, type DailyRow, type Issue, type MonthlyRow, type WeeklyRow } from '../../api/client'
import { useAdmin } from '../../hooks/useAdmin'

type Period = 'hourly_range' | 'day' | 'week' | 'month'

type Segment =
  | { type: 'bucket'; bucket: string }
  | { type: 'date'; date: string }
  | { type: 'week'; weekStart: string }
  | { type: 'month'; month: string }

interface CatGroup { total: number; subs: CategoryRow[] }
interface KpiCard { label: string; value: string; color: string }

const CATEGORY_ORDER = ['네트워크·앱 오류', '기기·하드웨어 오류', '미납·결제', '해지·유지 상담', '교재·물류·배송', '체험 관련', '계정·서비스', '기타']
const PAGE_SIZE = 100
const STEP_SIZES: Record<Period, number> = { hourly_range: 50, day: 200, week: 5000, month: 5000 }

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function snapToSunday(dateStr: string): string {
  const d = new Date(dateStr)
  const dow = d.getUTCDay()
  d.setUTCDate(d.getUTCDate() + (7 - dow) % 7)
  return d.toISOString().slice(0, 10)
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// "8월 3주차" 형식 라벨. 그 주(월요일 시작)의 목요일이 속한 달을 기준 월로 삼고, 그 달 1일이
// 속한 주(월요일 시작)를 1주차로 세어 나간다 — ISO 8601이 "그 주의 목요일이 속한 해"를
// 그 주의 연도로 정의하는 것과 같은 원리를 월 단위에 적용한 것. 이러면 08/31~09/06처럼
// 두 달에 걸친 주도 "9월 1주차"로 자연스럽게 붙는다(목요일인 09/03이 9월이라서).
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

function getPeriodRange(period: Period, sd: string, ed: string): { start: string; end: string } {
  const today = todayStr()
  if (period === 'hourly_range') return { start: sd, end: ed }
  if (period === 'day') { const d = new Date(); d.setDate(d.getDate() - 6); return { start: d.toISOString().slice(0, 10), end: today } }
  if (period === 'week') { const d = new Date(); d.setDate(d.getDate() - 30); return { start: d.toISOString().slice(0, 10), end: today } }
  const d = new Date(); d.setMonth(d.getMonth() - 2); d.setDate(1)
  return { start: d.toISOString().slice(0, 10), end: today }
}

function getActiveFilter(period: Period, sd: string, ed: string, seg: Segment | null): { start: string; end: string; bucket: string | null } {
  if (!seg) return { ...getPeriodRange(period, sd, ed), bucket: null }
  if (seg.type === 'bucket') return { ...getPeriodRange(period, sd, ed), bucket: seg.bucket }
  if (seg.type === 'date') return { start: seg.date, end: seg.date, bucket: null }
  if (seg.type === 'week') {
    const d = new Date(seg.weekStart + 'T00:00:00'); d.setDate(d.getDate() + 6)
    return { start: seg.weekStart, end: d.toISOString().slice(0, 10), bucket: null }
  }
  const [year, m] = seg.month.split('-').map(Number)
  return { start: `${seg.month}-01`, end: `${seg.month}-${String(new Date(year, m, 0).getDate()).padStart(2, '0')}`, bucket: null }
}

function bucketRangeLabel(b: string): string {
  if (b === '~09:00' || b === '21:00~') return b
  const [hh, mm] = b.split(':')
  const endMm = mm === '00' ? '30' : '00'
  const endHh = mm === '00' ? hh : String(Number(hh) + 1).padStart(2, '0')
  return `${b} ~ ${endHh}:${endMm}`
}

function segmentLabel(seg: Segment, filter: { start: string; end: string }): string {
  if (seg.type === 'bucket') return `시간대 필터: ${bucketRangeLabel(seg.bucket)}`
  if (seg.type === 'date') return `날짜 필터: ${seg.date}`
  if (seg.type === 'week') return `주 필터: ${filter.start} ~ ${filter.end}`
  return `월 필터: ${seg.month}`
}

function highlight(text: string | number | null | undefined, q: string): React.ReactNode {
  const t = text != null ? String(text) : ''
  if (!q || !t) return t
  const parts: React.ReactNode[] = []
  const lower = t.toLowerCase(), lq = q.toLowerCase()
  let last = 0, i = lower.indexOf(lq, last)
  while (i !== -1) {
    if (i > last) parts.push(t.slice(last, i))
    parts.push(<mark key={i} style={{ background: '#fef08a', color: 'inherit', borderRadius: 2, padding: '0 1px' }}>{t.slice(i, i + q.length)}</mark>)
    last = i + q.length
    i = lower.indexOf(lq, last)
  }
  if (last < t.length) parts.push(t.slice(last))
  return <>{parts}</>
}

// ── Component ────────────────────────────────────────────────────

export default function Dashboard() {
  const { isAdmin } = useAdmin()
  const today = todayStr()

  const [period, setPeriod] = useState<Period>('hourly_range')
  const [date, setDate] = useState(today)
  const [month, setMonth] = useState(today.slice(0, 7))
  const [startDate, setStartDate] = useState(today)
  const [endDate, setEndDate] = useState(today)
  const [segment, setSegment] = useState<Segment | null>(null)
  const [selectedBuckets, setSelectedBuckets] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')

  const [kpiCards, setKpiCards] = useState<KpiCard[]>([])
  const [chartTitle, setChartTitle] = useState('시간대별 상담 건수')

  const [sorted, setSorted] = useState<[string, CatGroup][]>([])
  const [catEmpty, setCatEmpty] = useState(false)
  const [catLoading, setCatLoading] = useState(true)
  const [selectedSub, setSelectedSub] = useState<{ main: string; sub?: string } | null>(null)

  const [memoItems, setMemoItems] = useState<Issue[]>([])
  const [memoTotal, setMemoTotal] = useState(0)
  const [memoPage, setMemoPage] = useState(0)
  const [memoLoading, setMemoLoading] = useState(false)
  const [memoSubKey, setMemoSubKey] = useState<{ main: string; sub?: string } | null>(null)

  const [reloadCount, setReloadCount] = useState(0)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const chartRowsRef = useRef<(BucketRow | DailyRow | WeeklyRow | MonthlyRow)[]>([])
  const periodRef = useRef<Period>('hourly_range')
  const autoIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Chart.js click handler always reads latest state via this ref
  const onChartClickRef = useRef<(idx: number) => void>(() => {})
  onChartClickRef.current = (idx: number) => {
    const row = chartRowsRef.current[idx]
    if (!row) return
    if (period === 'hourly_range') {
      const bucket = (row as BucketRow).bucket
      const next = selectedBuckets.includes(bucket)
        ? selectedBuckets.filter(b => b !== bucket)
        : [...selectedBuckets, bucket]
      setSelectedBuckets(next)
      clearMemoState()
      doLoadCategory(period, startDate, endDate, null, next, activeQuery).catch(console.error)
      return
    }
    let seg: Segment
    switch (period) {
      case 'day':   seg = { type: 'date', date: (row as DailyRow).date }; break
      case 'week':  seg = { type: 'week', weekStart: (row as WeeklyRow).week_start }; break
      default:      seg = { type: 'month', month: (row as MonthlyRow).month }
    }
    setSegment(seg)
    clearMemoState()
    doLoadCategory(period, startDate, endDate, seg, [], activeQuery).catch(console.error)
  }

  useEffect(() => { periodRef.current = period }, [period])

  // ── Chart ────────────────────────────────────────────────────

  function buildChart(
    labels: string[],
    data: number[],
    p: Period,
    title: string,
    opts: { avgData?: number[]; avgLabel?: string; highlightIdx?: number } = {}
  ) {
    setChartTitle(title)
    if (!canvasRef.current) return
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null }

    const { avgData, avgLabel = '평균', highlightIdx } = opts
    const bgColors = data.map((_, i) => i === highlightIdx ? '#1e40af' : '#93c5fd')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const datasets: any[] = [{
      label: '건수',
      data,
      backgroundColor: bgColors,
      borderRadius: 4,
      barPercentage: 0.65,
    }]

    if (avgData) {
      datasets.push({
        type: 'line',
        label: avgLabel,
        data: avgData,
        borderColor: '#94a3b8',
        borderDash: [4, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0,
        fill: false,
      })
    }

    chartRef.current = new Chart(canvasRef.current, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        onClick: (_ev, elements) => {
          if (elements.length) onChartClickRef.current(elements[0].index)
        },
        onHover: (ev, elements) => {
          const t = ev.native?.target as HTMLElement | undefined
          if (t) t.style.cursor = elements.length ? 'pointer' : 'default'
        },
        plugins: {
          legend: {
            display: !!avgData,
            position: 'top',
            labels: { boxWidth: 16, font: { size: 17 }, color: '#64748b' },
          },
          tooltip: {
            callbacks: {
              title: ctx => {
                const b = ctx[0].label
                if (periodRef.current !== 'hourly_range') return b
                return bucketRangeLabel(b)
              },
              label: ctx => ` ${(ctx.parsed.y ?? 0).toLocaleString()}건`,
            },
          },
        },
        scales: {
          y: { beginAtZero: true, ticks: { stepSize: STEP_SIZES[p], font: { size: 13 } }, grid: { color: '#f1f5f9' } },
          x: {
            grid: { display: false },
            ticks: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              font: (ctx: any) => {
                const emphasis = ctx.index === highlightIdx
                return { size: emphasis ? 16 : 13, weight: emphasis ? 'bold' : 'normal' }
              },
            },
          },
        },
      },
    })
  }

  // ── Load functions ───────────────────────────────────────────

  async function doLoadChart(p: Period, d: string, mo: string, sd: string, ed: string) {
    if (p === 'hourly_range') {
      const rows = await api.fetchHourly(sd, ed)
      chartRowsRef.current = rows
      const labels = rows.map(r => r.bucket)
      const data = rows.map(r => r.count)
      const total = data.reduce((s, v) => s + v, 0)
      const multiDay = sd !== ed

      const peakRow = rows.length > 0
        ? rows.reduce((max, r) => r.count > max.count ? r : max, rows[0])
        : { count: 0, bucket: '—' }
      // 전부 0건이면 reduce가 첫 버킷(예: 09:00)을 그대로 "피크"로 남겨서 실제로는 데이터가
      // 없는데도 강조(볼드) 표시가 되는 문제가 있었다 — 실제 건수가 있을 때만 강조한다.
      const highlightIdx = peakRow.count > 0 ? rows.indexOf(peakRow as BucketRow) : undefined
      const titleSuffix = multiDay ? ` (${sd} ~ ${ed})` : ` (${sd})`
      buildChart(labels, data, p, `시간대별 상담 건수${titleSuffix}`, { highlightIdx })

      // 오늘 하루만 봐도, 다른 하루만 봐도, 여러 날을 합쳐서 봐도 "얼마나 몰리는지"(집중도)가
      // 이 뷰의 목적(시간대별 쏠림 경향 파악)에 맞는다 — 그래서 세 경우를 전부 하나로 합친다.
      // ("동시간대 대비"는 오늘 이제 막 지난 시간대엔 -100% 같은 왜곡된 값이 나와서 뺐다.)
      const avgBucket = rows.length > 0 ? total / rows.length : 0
      const ratio = avgBucket > 0 ? peakRow.count / avgBucket : 0
      const cmpCard: KpiCard = {
        label: '피크 집중도',
        value: avgBucket > 0 ? `평균 대비 ${ratio.toFixed(1)}배` : '—',
        color: 'blue',
      }

      setKpiCards([
        { label: '선택 기간 상담', value: `${total.toLocaleString()}건`, color: 'blue' },
        {
          label: '피크 시간대',
          value: peakRow.count > 0 ? bucketRangeLabel(peakRow.bucket) : '—',
          color: 'amber',
        },
        cmpCard,
      ])

    } else if (p === 'day') {
      const rows = await api.fetchDaily(d, 'week') as DailyRow[]
      chartRowsRef.current = rows
      const labels = rows.map(r => r.date.slice(5).replace('-', '/'))
      const data = rows.map(r => r.count)

      // 오늘(아직 끝나지 않은 날)은 평일 평균에서 뺀다 — 안 그러면 완료된 날들과 미완료인
      // 오늘을 똑같이 취급해서 평균이 실제보다 낮게 나온다(정책 5: 진행 중인 구간은 비교 제외).
      const today = todayStr()
      const weekdayRows = rows.filter(r => {
        const dow = new Date(r.date + 'T00:00:00').getDay()
        return dow !== 0 && dow !== 6 && r.date !== today
      })
      const avg = weekdayRows.length > 0
        ? weekdayRows.reduce((s, r) => s + r.count, 0) / weekdayRows.length
        : data.reduce((s, v) => s + v, 0) / Math.max(data.length, 1)
      const avgRounded = Math.round(avg)
      const avgLine = data.map(() => avgRounded)

      const maxRow = rows.length > 0
        ? rows.reduce((max, r) => r.count > max.count ? r : max, rows[0])
        : null
      const highlightIdx = maxRow ? rows.indexOf(maxRow) : undefined

      buildChart(labels, data, p, `일별 상담 건수 (${rows[0]?.date ?? d} ~ ${d})`, {
        avgData: avgLine,
        avgLabel: '평일 평균',
        highlightIdx,
      })

      const total = data.reduce((s, v) => s + v, 0)
      setKpiCards([
        { label: '기간 총 상담', value: `${total.toLocaleString()}건`, color: 'blue' },
        { label: '평일 평균', value: `${avgRounded.toLocaleString()}건`, color: 'green' },
        { label: maxRow ? `최대 상담일 (${maxRow.count.toLocaleString()}건)` : '최대 상담일', value: maxRow ? maxRow.date.slice(5).replace('-', '/') : '—', color: 'amber' },
      ])

    } else if (p === 'week') {
      const rows = await api.fetchWeekly(d) as WeeklyRow[]
      chartRowsRef.current = rows
      const labels = rows.map(r => r.week_start.slice(5).replace('-', '/') + ' ~')
      const data = rows.map(r => r.count)

      // 이번 주(아직 안 끝남)는 "최다 상담 주"·"4주 평균" 둘 다에서 뺀다 — 정책 5와 같은
      // 이유로, 진행 중인 주를 완료된 주와 똑같이 취급하면 평균이 실제보다 낮게 나온다.
      const today = todayStr()
      const thisMonday = shiftDate(today, -((new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7))
      const completedRows = rows.filter(r => r.week_start !== thisMonday)

      const avg4 = completedRows.length > 0
        ? Math.round(completedRows.reduce((s, r) => s + r.count, 0) / completedRows.length)
        : 0
      const avgLine4 = data.map(() => avg4)

      const lastIdx = data.length - 1
      buildChart(labels, data, p, `주별 상담 건수 (${d}까지 4주)`, {
        avgData: avgLine4,
        avgLabel: '기간 평균',
        highlightIdx: lastIdx >= 0 ? lastIdx : undefined,
      })

      const latest = data[lastIdx] ?? 0
      const maxRow = completedRows.length > 0
        ? completedRows.reduce((max, r) => r.count > max.count ? r : max, completedRows[0])
        : null

      setKpiCards([
        { label: '이번 주 상담', value: `${latest.toLocaleString()}건`, color: 'blue' },
        {
          label: maxRow ? `최다 상담 주 (${monthWeekLabel(maxRow.week_start)})` : '최다 상담 주',
          value: maxRow ? `${maxRow.count.toLocaleString()}건` : '—',
          color: 'amber',
        },
        { label: '최근 4주 평균', value: `${avg4.toLocaleString()}건`, color: 'neutral' },
      ])

    } else {
      const rows = await api.fetchMonthly(mo + '-01') as MonthlyRow[]
      chartRowsRef.current = rows
      const labels = rows.map(r => r.month.slice(5) + '월')
      const data = rows.map(r => r.count)

      // 이번 달(아직 안 끝남)은 "최다 상담 달"·"기간 평균" 둘 다에서 뺀다 — 진행 중인 달을
      // 완료된 달과 똑같이 취급하면 평균이 실제보다 낮게 나온다(정책 5와 같은 이유).
      const thisMonth = todayStr().slice(0, 7)
      const completedRows = rows.filter(r => r.month !== thisMonth)

      const avgMo = completedRows.length > 0
        ? Math.round(completedRows.reduce((s, r) => s + r.count, 0) / completedRows.length)
        : 0
      const avgLineMo = data.map(() => avgMo)

      const lastIdx = data.length - 1
      buildChart(labels, data, p, `월별 상담 건수 (${mo})`, {
        avgData: avgLineMo,
        avgLabel: '기간 평균',
        highlightIdx: lastIdx >= 0 ? lastIdx : undefined,
      })

      const latest = data[lastIdx] ?? 0
      const maxRow = completedRows.length > 0
        ? completedRows.reduce((max, r) => r.count > max.count ? r : max, completedRows[0])
        : null

      setKpiCards([
        { label: '이번 달 상담', value: `${latest.toLocaleString()}건`, color: 'blue' },
        {
          label: maxRow ? `최다 상담 달 (${Number(maxRow.month.slice(5, 7))}월)` : '최다 상담 달',
          value: maxRow ? `${maxRow.count.toLocaleString()}건` : '—',
          color: 'amber',
        },
        { label: '최근 4개월 평균', value: `${avgMo.toLocaleString()}건`, color: 'neutral' },
      ])
    }
  }

  async function doLoadCategory(p: Period, sd: string, ed: string, seg: Segment | null, buckets: string[] = [], q = '') {
    setCatLoading(true)
    try {
      const { start, end } = getActiveFilter(p, sd, ed, seg)
      const rows = await api.fetchCategory({ startDate: start, endDate: end, buckets: buckets.length ? buckets : undefined, q: q || undefined })
      if (!rows.length) { setCatEmpty(true); setSorted([]); return }
      setCatEmpty(false)
      const grouped: Record<string, CatGroup> = {}
      rows.forEach(r => {
        if (!grouped[r.new_category_main]) grouped[r.new_category_main] = { total: 0, subs: [] }
        grouped[r.new_category_main].total += r.count
        grouped[r.new_category_main].subs.push(r)
      })
      const s = Object.entries(grouped).sort((a, b) => {
        const ai = CATEGORY_ORDER.indexOf(a[0]), bi = CATEGORY_ORDER.indexOf(b[0])
        if (ai === -1 && bi === -1) return b[1].total - a[1].total
        if (ai === -1) return 1; if (bi === -1) return -1
        return ai - bi
      })
      setSorted(s)
    } finally {
      setCatLoading(false)
    }
  }

  async function loadMemos(main: string, sub: string | undefined, page: number) {
    setMemoLoading(true)
    try {
      const { start, end } = getActiveFilter(period, startDate, endDate, segment)
      const isUnclassified = !main || main === 'null'
      const result = await api.fetchIssues({
        startDate: start, endDate: end,
        buckets: period === 'hourly_range' && selectedBuckets.length ? selectedBuckets : undefined,
        q: activeQuery || undefined,
        ...(isUnclassified ? { unclassified: true } : { categoryMain: main, categorySub: sub }),
        limit: PAGE_SIZE, offset: page * PAGE_SIZE,
      })
      setMemoItems(result.items)
      setMemoTotal(result.total)
    } finally {
      setMemoLoading(false)
    }
  }

  function clearMemoState() {
    setSelectedSub(null); setMemoItems([]); setMemoTotal(0); setMemoPage(0); setMemoSubKey(null)
  }

  // ── Effects ──────────────────────────────────────────────────

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSegment(null)
    setSelectedBuckets([])
    clearMemoState()
    Promise.all([
      doLoadChart(period, date, month, startDate, endDate),
      doLoadCategory(period, startDate, endDate, null, [], activeQuery),
    ]).catch(console.error)
  }, [period, date, month, startDate, endDate, reloadCount])

  useEffect(() => {
    const now = new Date()
    const msToNext = (30 - (now.getMinutes() % 30)) * 60 * 1000 - now.getSeconds() * 1000 - now.getMilliseconds()
    const tid = setTimeout(() => {
      setReloadCount(c => c + 1)
      autoIntervalRef.current = setInterval(() => setReloadCount(c => c + 1), 30 * 60 * 1000)
    }, msToNext)
    return () => {
      clearTimeout(tid)
      if (autoIntervalRef.current) { clearInterval(autoIntervalRef.current); autoIntervalRef.current = null }
    }
  }, [])

  useEffect(() => () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null } }, [])

  // 버킷 선택 변경 시 차트 색상만 업데이트 (데이터 재조회 없음)
  useEffect(() => {
    if (period !== 'hourly_range' || !chartRef.current) return
    const rows = chartRowsRef.current as BucketRow[]
    if (!rows.length) return
    const peakRow = rows.reduce((max, r) => r.count > max.count ? r : max, rows[0])
    const peakBucket = peakRow.count > 0 ? peakRow.bucket : null
    const labels = (chartRef.current.data.labels ?? []) as string[]
    const ds = chartRef.current.data.datasets[0]
    ds.backgroundColor = labels.map(l => {
      if (selectedBuckets.length > 0) return selectedBuckets.includes(l) ? '#1e40af' : '#e2e8f0'
      return l === peakBucket ? '#1e40af' : '#93c5fd'
    })
    chartRef.current.update('none')
  }, [selectedBuckets, period])

  // ── Handlers ─────────────────────────────────────────────────

  function handleTabClick(p: Period) {
    let newDate = date
    if (p === 'week') { newDate = snapToSunday(todayStr()); setDate(newDate) }
    else if (p === 'day') { newDate = todayStr(); setDate(newDate) }
    setPeriod(p)
  }

  async function selectSub(main: string, sub: string) {
    setSelectedSub({ main, sub })
    setMemoSubKey({ main, sub })
    setMemoPage(0)
    await loadMemos(main, sub, 0)
  }

  // 대카테고리 헤더 클릭 — 소분류 지정 없이 그 대분류 전체 메모를 본다.
  async function selectMain(main: string) {
    setSelectedSub({ main })
    setMemoSubKey({ main })
    setMemoPage(0)
    await loadMemos(main, undefined, 0)
  }

  async function movePage(dir: number) {
    if (!memoSubKey) return
    const newPage = memoPage + dir
    setMemoPage(newPage)
    await loadMemos(memoSubKey.main, memoSubKey.sub, newPage)
  }

  function clearFilter() {
    setSegment(null)
    setSelectedBuckets([])
    clearMemoState()
    doLoadCategory(period, startDate, endDate, null, [], activeQuery).catch(console.error)
  }

  function applySearch(q: string) {
    setActiveQuery(q)
    clearMemoState()
    doLoadCategory(period, startDate, endDate, segment, selectedBuckets, q).catch(console.error)
  }

  function clearSearch() {
    setSearchQuery('')
    setActiveQuery('')
    clearMemoState()
    doLoadCategory(period, startDate, endDate, segment, selectedBuckets, '').catch(console.error)
  }

  // ── Derived ──────────────────────────────────────────────────

  const totalPages = Math.ceil(memoTotal / PAGE_SIZE)
  const activeFilter = segment ? getActiveFilter(period, startDate, endDate, segment) : null
  const segLabel = segment && activeFilter ? segmentLabel(segment, activeFilter) : null

  // ── Render ───────────────────────────────────────────────────

  return (
    <div className="container">

      {/* Toolbar */}
      <div className="toolbar">
        <div className="tabs">
          {(['hourly_range', 'day', 'week', 'month'] as Period[]).map(p => (
            <button key={p} className={period === p ? 'active' : ''} onClick={() => handleTabClick(p)}>
              {p === 'hourly_range' ? '시간별' : p === 'day' ? '일별' : p === 'week' ? '주별' : '월별'}
            </button>
          ))}
        </div>

        {period === 'hourly_range' && (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="date" value={startDate} max={todayStr()} onChange={e => setStartDate(e.target.value)} />
            <span style={{ color: '#94a3b8' }}>~</span>
            <input type="date" value={endDate} max={todayStr()} onChange={e => setEndDate(e.target.value)} />
          </span>
        )}
        {(period === 'day' || period === 'week') && (
          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button className="refresh-btn" style={{ padding: '8px 10px' }} onClick={() => setDate(shiftDate(date, period === 'week' ? -7 : -1))}>‹</button>
            <input type="date" value={date}
              step={period === 'week' ? 7 : undefined}
              min={period === 'week' ? '2020-01-05' : undefined}
              max={todayStr()}
              onChange={e => setDate(e.target.value)} />
            <button className="refresh-btn" style={{ padding: '8px 10px' }} onClick={() => setDate(shiftDate(date, period === 'week' ? 7 : 1))}>›</button>
          </span>
        )}
        {period === 'month' && (
          <input type="month" value={month} max={todayStr().slice(0, 7)} onChange={e => setMonth(e.target.value)} />
        )}

        <button className="refresh-btn" onClick={() => setReloadCount(c => c + 1)}>↻ 새로고침</button>
      </div>

      {/* KPI Cards */}
      <div className="cards">
        {kpiCards.map((card, i) => (
          <div key={i} className={`card ${card.color}`}>
            <div className="label">{card.label}</div>
            <div className="value">{card.value}</div>
          </div>
        ))}
      </div>

      {/* Chart */}
      <div className="chart-card">
        <h2>{chartTitle}</h2>
        <canvas ref={canvasRef} id="main-chart" />
      </div>

      {/* Category + Memos */}
      <div className="section-card">
        <h2 style={{ fontSize: 20 }}>카테고리별 건수</h2>
        {/* Search bar — full width */}
        <form onSubmit={e => { e.preventDefault(); applySearch(searchQuery.trim()) }}
          style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <div style={{ position: 'relative', flex: '0 0 50%' }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', pointerEvents: 'none', fontSize: 18 }}>🔍</span>
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="학부모번호 · 학생번호 · 메모 내용으로 검색"
              style={{ width: '100%', padding: '14px 32px 14px 32px', border: `1px solid ${activeQuery ? '#3b82f6' : '#e2e8f0'}`, borderRadius: 8, fontSize: 18, color: '#374151', outline: 'none', boxSizing: 'border-box' }}
            />
            {searchQuery && (
              <button type="button" onClick={clearSearch}
                style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
            )}
          </div>
          <button type="submit"
            style={{ padding: '14px 18px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8, fontSize: 18, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>검색</button>
        </form>

        {/* Unified active filter chips — search + time slot in one row */}
        {(activeQuery || (period === 'hourly_range' && selectedBuckets.length > 0) || (period !== 'hourly_range' && segment)) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, padding: '6px 10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 12, flexWrap: 'wrap' }}>
            <span style={{ color: '#94a3b8', fontWeight: 600, fontSize: 11, marginRight: 2 }}>적용된 필터</span>
            {activeQuery && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: '#fef9c3', color: '#854d0e', borderRadius: 999, padding: '2px 10px', fontWeight: 500 }}>
                "{activeQuery}"
                <button onClick={clearSearch} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#854d0e', fontSize: 14, lineHeight: 1, padding: 0, marginLeft: 1 }}>×</button>
              </span>
            )}
            {period === 'hourly_range' && selectedBuckets.map(b => (
              <span key={b} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: '#dbeafe', color: '#1a56db', borderRadius: 999, padding: '2px 10px', fontWeight: 500 }}>
                {bucketRangeLabel(b)}
                <button
                  onClick={() => {
                    const next = selectedBuckets.filter(x => x !== b)
                    setSelectedBuckets(next)
                    clearMemoState()
                    doLoadCategory(period, startDate, endDate, null, next, activeQuery).catch(console.error)
                  }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1a56db', fontSize: 14, lineHeight: 1, padding: 0, marginLeft: 1 }}>×</button>
              </span>
            ))}
            {period !== 'hourly_range' && segment && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: '#dbeafe', color: '#1a56db', borderRadius: 999, padding: '2px 10px', fontWeight: 500 }}>
                {segLabel}
                <button onClick={clearFilter} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1a56db', fontSize: 14, lineHeight: 1, padding: 0, marginLeft: 1 }}>×</button>
              </span>
            )}
            <button onClick={() => { clearSearch(); clearFilter() }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 11, marginLeft: 'auto' }}>전체 해제</button>
          </div>
        )}

        <div className="cat-layout">
          {/* Category tree — keep stale data dimmed while reloading to prevent height jump */}
          <div className="cat-tree" style={{ opacity: catLoading ? 0.55 : 1, transition: 'opacity 0.15s', pointerEvents: catLoading ? 'none' : 'auto' }}>
            {catLoading && !sorted.length ? (
              <div className="loading">조회 중...</div>
            ) : !catLoading && catEmpty ? (
              <div className="empty">데이터 없음</div>
            ) : sorted.map(([main, g]) => {
              const isMainActive = selectedSub?.main === main && !selectedSub?.sub
              return (
              <div key={main || '__null__'}>
                <div
                  className={`cat-main-header${isMainActive ? ' active' : ''}`}
                  onClick={() => selectMain(main)}
                >
                  <span>{(!main || main === 'null') ? '미분류' : main}</span>
                  <span className="main-count">{g.total.toLocaleString()}</span>
                </div>
                {[...g.subs].sort((a, b) => b.count - a.count).map(sub => {
                  const subKey = sub.new_category_sub
                  const isActive = selectedSub?.main === main && selectedSub?.sub === subKey
                  return (
                    <div
                      key={subKey || '__null__'}
                      className={`cat-sub-item${isActive ? ' active' : ''}`}
                      onClick={() => selectSub(main, subKey)}
                    >
                      <span className="sub-item-name">{(!subKey || subKey === 'null') ? '미분류' : subKey}</span>
                      <span className="sub-item-count">{sub.count.toLocaleString()}</span>
                    </div>
                  )
                })}
              </div>
              )
            })}
          </div>

          {/* Memo panel */}
          <div className="cat-memo-panel">
            {!memoSubKey ? (
              <div className="memo-placeholder">소분류를 선택하면 상담 메모가 표시됩니다</div>
            ) : memoLoading ? (
              <div className="loading">조회 중...</div>
            ) : (
              <>
                <div className="memo-header">
                  <div className="memo-title">
                    {(!memoSubKey.main || memoSubKey.main === 'null') ? '미분류' : memoSubKey.main}
                    {memoSubKey.sub && <> &rsaquo; {memoSubKey.sub}</>}
                  </div>
                  <div className="memo-count">총 {memoTotal.toLocaleString()}건 · {memoPage + 1} / {totalPages || 1} 페이지</div>
                </div>
                {!memoItems.length ? (
                  <div className="empty">데이터 없음</div>
                ) : (
                  <>
                    <table>
                      <thead>
                        <tr>
                          <th style={{ width: 150, fontSize: 16 }}>학생번호</th>
                          <th style={{ width: 150, fontSize: 16 }}>학부모번호</th>
                          <th style={{ fontSize: 16 }}>상담 메모</th>
                          <th style={{ width: 150, fontSize: 16 }}>접수 시각</th>
                          {isAdmin && <th style={{ width: 120 }}>매칭 키워드</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {memoItems.map(r => (
                          <tr key={r.id}>
                            <td style={{ fontSize: 15 }}>
                              {r.student_id
                                ? <a href={adminStudentUrl(r.student_id)} target="_blank" rel="noreferrer" style={{ color: '#1a56db', textDecoration: 'none' }}>{activeQuery ? highlight(r.student_id, activeQuery) : r.student_id}</a>
                                : <span style={{ color: '#64748b' }}>—</span>}
                            </td>
                            <td style={{ fontSize: 15 }}>
                              {r.parent_id
                                ? <a href={adminParentUrl(r.parent_id!)} target="_blank" rel="noreferrer" style={{ color: '#1a56db', textDecoration: 'none' }}>{activeQuery ? highlight(r.parent_id, activeQuery) : r.parent_id}</a>
                                : <span style={{ color: '#94a3b8' }}>비회원</span>}
                            </td>
                            <td style={{ color: '#374151', fontSize: 15 }}>
                              {r.call_memo
                                ? r.call_memo.split('\n').map((line, i) => <span key={i}>{i > 0 && <br />}{activeQuery ? highlight(line, activeQuery) : line}</span>)
                                : <span style={{ color: '#cbd5e1' }}>없음</span>}
                            </td>
                            <td style={{ whiteSpace: 'nowrap', color: '#64748b', fontSize: 15 }}>{r.created_date ? r.created_date.slice(0, 16) : '—'}</td>
                            {isAdmin && (
                              <td style={{ fontSize: 15, color: r.matched_keyword ? '#334155' : '#cbd5e1' }}>
                                {r.matched_keyword ?? '—'}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {totalPages > 1 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 0 4px', justifyContent: 'center' }}>
                        <button
                          onClick={() => movePage(-1)} disabled={memoPage === 0}
                          style={{ padding: '6px 14px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', cursor: memoPage === 0 ? 'default' : 'pointer', fontSize: 13, color: '#374151', opacity: memoPage === 0 ? 0.4 : 1 }}
                        >← 이전</button>
                        <span style={{ fontSize: 13, color: '#64748b' }}>{memoPage + 1} / {totalPages}</span>
                        <button
                          onClick={() => movePage(1)} disabled={memoPage >= totalPages - 1}
                          style={{ padding: '6px 14px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', cursor: memoPage >= totalPages - 1 ? 'default' : 'pointer', fontSize: 13, color: '#374151', opacity: memoPage >= totalPages - 1 ? 0.4 : 1 }}
                        >다음 →</button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
