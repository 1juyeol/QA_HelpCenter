// 메인 대시보드 페이지. 이 파일 하나에 대시보드의 모든 UI와 상태 관리가 집중되어 있다.
// 주요 기능: 시간대별·일별·주별·월별 탭 전환 / KPI 카드(동시간대 대비·평균 대비) /
// Chart.js 차트(Bar·Line) / 카테고리 드릴다운(대분류→소분류→메모 목록) /
// 피크 시간대 하이라이트 / 정시·30분 자동 리로드.
// 데이터 흐름: api/client.ts 함수 호출 → 상태 업데이트 → Chart.js 재렌더링 → DOM 반영.
import { useEffect, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import { api, adminStudentUrl, adminParentUrl, type BucketRow, type CategoryRow, type DailyRow, type Issue, type MonthlyRow, type WeeklyRow } from '../../api/client'

type Period = 'hourly_range' | 'day' | 'week' | 'month'

type Segment =
  | { type: 'bucket'; bucket: string }
  | { type: 'date'; date: string }
  | { type: 'week'; weekStart: string }
  | { type: 'month'; month: string }

interface CatGroup { total: number; subs: CategoryRow[] }
interface KpiCard { label: string; value: string; sub: string; color: string }

const CATEGORY_ORDER = ['네트워크·앱 오류', '기기·하드웨어 오류', '미납·결제', '해지·유지 상담', '교재·물류·배송', '체험 관련', '계정·서비스', '기타']
const PAGE_SIZE = 100
const STEP_SIZES: Record<Period, number> = { hourly_range: 50, day: 200, week: 5000, month: 5000 }

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getCurrentBucket(): string {
  const now = new Date()
  const total = now.getHours() * 60 + now.getMinutes()
  const completed = total - (total % 30) - 30
  if (completed < 9 * 60) return '~09:00'
  if (completed >= 21 * 60) return '21:00~'
  const h = Math.floor(completed / 60)
  const m = completed % 60
  return `${String(h).padStart(2, '0')}:${m === 0 ? '00' : '30'}`
}

function snapToSunday(dateStr: string): string {
  const d = new Date(dateStr)
  const dow = d.getUTCDay()
  d.setUTCDate(d.getUTCDate() + (7 - dow) % 7)
  return d.toISOString().slice(0, 10)
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

// ── Component ────────────────────────────────────────────────────

export default function Dashboard() {
  const today = todayStr()

  const [period, setPeriod] = useState<Period>('hourly_range')
  const [date, setDate] = useState(today)
  const [month, setMonth] = useState(today.slice(0, 7))
  const [startDate, setStartDate] = useState(today)
  const [endDate, setEndDate] = useState(today)
  const [segment, setSegment] = useState<Segment | null>(null)
  const [selectedBuckets, setSelectedBuckets] = useState<string[]>([])

  const [kpiCards, setKpiCards] = useState<KpiCard[]>([])
  const [chartTitle, setChartTitle] = useState('시간대별 상담 건수')

  const [sorted, setSorted] = useState<[string, CatGroup][]>([])
  const [catEmpty, setCatEmpty] = useState(false)
  const [catLoading, setCatLoading] = useState(true)
  const [selectedSub, setSelectedSub] = useState<{ main: string; sub: string } | null>(null)

  const [memoItems, setMemoItems] = useState<Issue[]>([])
  const [memoTotal, setMemoTotal] = useState(0)
  const [memoPage, setMemoPage] = useState(0)
  const [memoLoading, setMemoLoading] = useState(false)
  const [memoSubKey, setMemoSubKey] = useState<{ main: string; sub: string } | null>(null)

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
      doLoadCategory(period, startDate, endDate, null, next).catch(console.error)
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
    doLoadCategory(period, startDate, endDate, seg).catch(console.error)
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
            labels: { boxWidth: 16, font: { size: 12 }, color: '#64748b' },
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
          y: { beginAtZero: true, ticks: { stepSize: STEP_SIZES[p] }, grid: { color: '#f1f5f9' } },
          x: { grid: { display: false } },
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
      const isToday = !multiDay && sd === todayStr()

      const peakRow = rows.length > 0
        ? rows.reduce((max, r) => r.count > max.count ? r : max, rows[0])
        : { count: 0, bucket: '—' }
      const highlightIdx = rows.indexOf(peakRow as BucketRow)
      const titleSuffix = multiDay ? ` (${sd} ~ ${ed} 누적)` : ` (${sd})`
      buildChart(labels, data, p, `시간대별 상담 건수${titleSuffix}`, { highlightIdx })

      let cmpCard: KpiCard
      if (isToday) {
        const cb = getCurrentBucket()
        const yd = new Date(sd); yd.setUTCDate(yd.getUTCDate() - 1)
        const ydRows = await api.fetchHourly(yd.toISOString().slice(0, 10), yd.toISOString().slice(0, 10))
        const cutoff = (chartRowsRef.current as BucketRow[]).findIndex(r => r.bucket === cb)
        const todayCut = cutoff >= 0 ? (chartRowsRef.current as BucketRow[]).slice(0, cutoff + 1).reduce((s, r) => s + r.count, 0) : total
        const prev = cutoff >= 0 ? ydRows.slice(0, cutoff + 1).reduce((s, r) => s + r.count, 0) : ydRows.reduce((s, r) => s + r.count, 0)
        const diff = todayCut - prev, sign = diff >= 0 ? '+' : ''
        const pct = prev > 0 ? ` (${sign}${Math.round(diff / prev * 100)}%)` : ''
        cmpCard = { label: '동시간대 대비', value: `${sign}${diff.toLocaleString()}건`, sub: `어제 ~${cb}${pct}`, color: diff >= 0 ? 'green' : 'red' }
      } else if (sd === ed) {
        const pe = new Date(sd); pe.setUTCDate(pe.getUTCDate() - 1)
        const prevRows = await api.fetchHourly(pe.toISOString().slice(0, 10), pe.toISOString().slice(0, 10))
        const prev = prevRows.reduce((s, r) => s + r.count, 0)
        const diff = total - prev, sign = diff >= 0 ? '+' : ''
        const pct = prev > 0 ? ` (${sign}${Math.round(diff / prev * 100)}%)` : ''
        cmpCard = {
          label: '전일 대비',
          value: prev > 0 ? `${sign}${diff.toLocaleString()}건` : '비교 불가',
          sub: prev > 0 ? `전일 ${prev.toLocaleString()}건${pct}` : '전일 데이터 없음',
          color: prev > 0 ? (diff >= 0 ? 'green' : 'red') : 'neutral',
        }
      } else {
        let weekdays = 0
        const cur = new Date(sd + 'T00:00:00')
        const endD = new Date(ed + 'T00:00:00')
        while (cur <= endD) {
          const dow = cur.getDay()
          if (dow !== 0 && dow !== 6) weekdays++
          cur.setDate(cur.getDate() + 1)
        }
        const avg = weekdays > 0 ? Math.round(total / weekdays) : 0
        cmpCard = {
          label: '평일 일평균',
          value: weekdays > 0 ? `${avg.toLocaleString()}건/일` : '—',
          sub: `평일 ${weekdays}일 기준`,
          color: 'blue',
        }
      }

      setKpiCards([
        { label: '선택 기간 상담', value: `${total.toLocaleString()}건`, sub: multiDay ? '기간 누적 합계' : '일 합계', color: 'blue' },
        cmpCard,
        {
          label: '피크 시간대',
          value: peakRow.count > 0 ? bucketRangeLabel(peakRow.bucket) : '—',
          sub: peakRow.count > 0 ? `${peakRow.count.toLocaleString()}건 집중` : '—',
          color: 'amber',
        },
      ])

    } else if (p === 'day') {
      const rows = await api.fetchDaily(d, 'week') as DailyRow[]
      chartRowsRef.current = rows
      const labels = rows.map(r => r.date.slice(5))
      const data = rows.map(r => r.count)

      const weekdayRows = rows.filter(r => {
        const dow = new Date(r.date + 'T00:00:00').getDay()
        return dow !== 0 && dow !== 6
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
        { label: '기간 총 상담', value: `${total.toLocaleString()}건`, sub: `${rows.length}일 합계`, color: 'blue' },
        { label: '평일 일평균', value: `${avgRounded.toLocaleString()}건`, sub: weekdayRows.length > 0 ? `평일 ${weekdayRows.length}일 기준` : '평일 데이터 없음', color: 'green' },
        { label: '최대 상담일', value: maxRow?.date.slice(5) ?? '—', sub: maxRow ? `${maxRow.count.toLocaleString()}건` : '—', color: 'amber' },
      ])

    } else if (p === 'week') {
      const rows = await api.fetchWeekly(d) as WeeklyRow[]
      chartRowsRef.current = rows
      const labels = rows.map(r => r.week_start.slice(5) + ' ~')
      const data = rows.map(r => r.count)

      const movingAvg = data.map((_, i) => {
        const w = data.slice(Math.max(0, i - 3), i + 1)
        return Math.round(w.reduce((s, v) => s + v, 0) / w.length)
      })

      const lastIdx = data.length - 1
      buildChart(labels, data, p, `주별 상담 건수 (${d} 기준 4주)`, {
        avgData: movingAvg,
        avgLabel: '4주 이동평균',
        highlightIdx: lastIdx >= 0 ? lastIdx : undefined,
      })

      const latest = data[lastIdx] ?? 0
      const prev = lastIdx > 0 ? data[lastIdx - 1] : null
      const avg4 = data.length > 0 ? Math.round(data.reduce((s, v) => s + v, 0) / data.length) : 0

      const prevCard: KpiCard = prev != null
        ? (() => {
            const diff = latest - prev, sign = diff >= 0 ? '+' : ''
            const pct = prev > 0 ? ` (${sign}${Math.round(diff / prev * 100)}%)` : ''
            return { label: '전주 대비', value: `${sign}${diff.toLocaleString()}건`, sub: `전주 ${prev.toLocaleString()}건${pct}`, color: diff >= 0 ? 'green' : 'red' }
          })()
        : { label: '전주 대비', value: '비교 불가', sub: '이전 주 데이터 없음', color: 'neutral' }

      setKpiCards([
        { label: '이번 주 상담', value: `${latest.toLocaleString()}건`, sub: rows[lastIdx] ? `${rows[lastIdx].week_start} 주` : '', color: 'blue' },
        prevCard,
        { label: '4주 평균', value: `${avg4.toLocaleString()}건`, sub: `최근 ${data.length}주 기준`, color: 'neutral' },
      ])

    } else {
      const rows = await api.fetchMonthly(mo + '-01') as MonthlyRow[]
      chartRowsRef.current = rows
      const labels = rows.map(r => r.month.slice(5) + '월')
      const data = rows.map(r => r.count)

      const movingAvg = data.map((_, i) => {
        const w = data.slice(Math.max(0, i - 2), i + 1)
        return Math.round(w.reduce((s, v) => s + v, 0) / w.length)
      })

      const lastIdx = data.length - 1
      buildChart(labels, data, p, `월별 상담 건수 (${mo} 기준)`, {
        avgData: movingAvg,
        avgLabel: '3개월 이동평균',
        highlightIdx: lastIdx >= 0 ? lastIdx : undefined,
      })

      const latest = data[lastIdx] ?? 0
      const prev = lastIdx > 0 ? data[lastIdx - 1] : null
      const avg = data.length > 0 ? Math.round(data.reduce((s, v) => s + v, 0) / data.length) : 0

      const prevCard: KpiCard = prev != null
        ? (() => {
            const diff = latest - prev, sign = diff >= 0 ? '+' : ''
            const pct = prev > 0 ? ` (${sign}${Math.round(diff / prev * 100)}%)` : ''
            return { label: '전월 대비', value: `${sign}${diff.toLocaleString()}건`, sub: `전월 ${prev.toLocaleString()}건${pct}`, color: diff >= 0 ? 'green' : 'red' }
          })()
        : { label: '전월 대비', value: '비교 불가', sub: '이전 달 데이터 없음', color: 'neutral' }

      setKpiCards([
        { label: '이번 달 상담', value: `${latest.toLocaleString()}건`, sub: rows[lastIdx]?.month ?? mo, color: 'blue' },
        prevCard,
        { label: '기간 평균', value: `${avg.toLocaleString()}건`, sub: `최근 ${data.length}개월 기준`, color: 'neutral' },
      ])
    }
  }

  async function doLoadCategory(p: Period, sd: string, ed: string, seg: Segment | null, buckets: string[] = []) {
    setCatLoading(true)
    try {
      const { start, end } = getActiveFilter(p, sd, ed, seg)
      const rows = await api.fetchCategory({ startDate: start, endDate: end, buckets: buckets.length ? buckets : undefined })
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

  async function loadMemos(main: string, sub: string, page: number) {
    setMemoLoading(true)
    try {
      const { start, end } = getActiveFilter(period, startDate, endDate, segment)
      const isUnclassified = !main || main === 'null'
      const result = await api.fetchIssues({
        startDate: start, endDate: end,
        buckets: period === 'hourly_range' && selectedBuckets.length ? selectedBuckets : undefined,
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
      doLoadCategory(period, startDate, endDate, null, []),
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
    const peakBucket = rows.reduce((max, r) => r.count > max.count ? r : max, rows[0]).bucket
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
    doLoadCategory(period, startDate, endDate, null, []).catch(console.error)
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
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
            <span style={{ color: '#94a3b8' }}>~</span>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
          </span>
        )}
        {(period === 'day' || period === 'week') && (
          <input type="date" value={date}
            step={period === 'week' ? 7 : undefined}
            min={period === 'week' ? '2020-01-05' : undefined}
            onChange={e => setDate(e.target.value)} />
        )}
        {period === 'month' && (
          <input type="month" value={month} onChange={e => setMonth(e.target.value)} />
        )}

        <button className="refresh-btn" onClick={() => setReloadCount(c => c + 1)}>↻ 새로고침</button>
      </div>

      {/* KPI Cards */}
      <div className="cards">
        {kpiCards.map((card, i) => (
          <div key={i} className={`card ${card.color}`}>
            <div className="label">{card.label}</div>
            <div className="value" style={card.value.length > 9 ? { fontSize: 20 } : undefined}>{card.value}</div>
            <div className="sub">{card.sub}</div>
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
        <h2>카테고리별 건수</h2>
        {period === 'hourly_range' && selectedBuckets.length > 0 && (
          <div style={{ display: 'flex', marginBottom: 12, padding: '6px 12px', background: '#eff6ff', borderRadius: 6, fontSize: 12, color: '#1a56db', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, marginRight: 2 }}>시간대 필터</span>
            {selectedBuckets.map(b => (
              <span key={b} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: '#dbeafe', borderRadius: 999, padding: '2px 10px', fontWeight: 500 }}>
                {bucketRangeLabel(b)}
                <button
                  onClick={() => {
                    const next = selectedBuckets.filter(x => x !== b)
                    setSelectedBuckets(next)
                    clearMemoState()
                    doLoadCategory(period, startDate, endDate, null, next).catch(console.error)
                  }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1a56db', fontSize: 14, lineHeight: 1, padding: 0, marginLeft: 2 }}
                >×</button>
              </span>
            ))}
            <button onClick={clearFilter} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 11, marginLeft: 'auto' }}>전체 해제</button>
          </div>
        )}
        {period !== 'hourly_range' && segment && (
          <div id="cat-filter-indicator" style={{ display: 'flex', marginBottom: 12, padding: '6px 12px', background: '#eff6ff', borderRadius: 6, fontSize: 12, color: '#1a56db', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{segLabel}</span>
            <button onClick={clearFilter} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1a56db', fontSize: 16, lineHeight: '1', padding: '0 0 0 8px' }}>×</button>
          </div>
        )}

        <div className="cat-layout">
          {/* Category tree */}
          <div className="cat-tree">
            {catLoading ? (
              <div className="loading">불러오는 중...</div>
            ) : catEmpty ? (
              <div className="empty">데이터 없음</div>
            ) : sorted.map(([main, g]) => (
              <div key={main || '__null__'}>
                <div className="cat-main-header">
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
            ))}
          </div>

          {/* Memo panel */}
          <div className="cat-memo-panel">
            {!memoSubKey ? (
              <div className="memo-placeholder">소분류를 선택하면 상담 메모가 표시됩니다</div>
            ) : memoLoading ? (
              <div className="loading">불러오는 중...</div>
            ) : (
              <>
                <div className="memo-header">
                  <div className="memo-title">
                    {(!memoSubKey.main || memoSubKey.main === 'null') ? '미분류' : memoSubKey.main} &rsaquo; {memoSubKey.sub}
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
                          <th style={{ width: 90 }}>학생번호</th>
                          <th style={{ width: 90 }}>학부모번호</th>
                          <th>상담 메모</th>
                          <th style={{ width: 130 }}>접수 시각</th>
                        </tr>
                      </thead>
                      <tbody>
                        {memoItems.map(r => (
                          <tr key={r.id}>
                            <td style={{ fontSize: 12 }}>
                              {r.student_id
                                ? <a href={adminStudentUrl(r.student_id)} target="_blank" rel="noreferrer" style={{ color: '#1a56db', textDecoration: 'none' }}>{r.student_id}</a>
                                : <span style={{ color: '#64748b' }}>—</span>}
                            </td>
                            <td style={{ fontSize: 12 }}>
                              {r.parent_id
                                ? <a href={adminParentUrl(r.parent_id!)} target="_blank" rel="noreferrer" style={{ color: '#1a56db', textDecoration: 'none' }}>{r.parent_id}</a>
                                : <span style={{ color: '#94a3b8' }}>비회원</span>}
                            </td>
                            <td style={{ color: '#374151', fontSize: 13 }}>
                              {r.call_memo
                                ? r.call_memo.split('\n').map((line, i) => <span key={i}>{i > 0 && <br />}{line}</span>)
                                : <span style={{ color: '#cbd5e1' }}>없음</span>}
                            </td>
                            <td style={{ whiteSpace: 'nowrap', color: '#64748b', fontSize: 12 }}>{r.created_date ? r.created_date.slice(0, 16) : '—'}</td>
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
