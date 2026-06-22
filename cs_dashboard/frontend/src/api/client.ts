// 모든 백엔드 API 호출과 TypeScript 타입을 한 곳에 모은다. 컴포넌트는 직접 fetch를 쓰지 않고 이 모듈만 참조한다.
// 엔드포인트 경로·파라미터 변경이 생기면 이 파일만 수정하면 된다 (정책 9).
//
// [student_id / parent_id 참고]
// 두 ID 모두 help-desk 원본 데이터에서 오며, 내부 어드민 페이지 URL에 직접 사용된다.
//   학생 상세: https://ad.wink.co.kr/members/search/students/{student_id}/basic/read
//   학부모 상세: https://ad.wink.co.kr/members/member/parents/{parent_id}/basic/read
// 이 URL들은 fetch 호출이 아니라 브라우저 직접 이동(<a href>)이므로 api 함수가 아닌
// 컴포넌트(Dashboard.tsx, RepeatParents.tsx)에 링크로 박혀 있다.
// parent_id=92 는 내부 계정이므로 백엔드에서 NULL 처리 후 내려온다.

// ── 타입 정의 ────────────────────────────────────────────────────

export interface BucketRow   { bucket: string; count: number }
export interface DailyRow    { date: string; count: number }
export interface WeeklyRow   { week_start: string; count: number }
export interface MonthlyRow  { month: string; count: number }

export interface CategoryRow {
  new_category_main: string
  new_category_sub: string
  count: number
}

export interface Issue {
  id: number
  created_date: string
  new_category_main: string | null
  new_category_sub: string | null
  call_memo: string
  student_id: string
  parent_id: string | null
}

export interface IssueList { total: number; items: Issue[] }

export interface InsightWings {
  ticket_id: string
  cs_count: number
  state?: string  // Wings API에서 조회한 실제 상태 (신규·진행 중·해결·요청취소 등). 토큰 미설정 시 undefined.
  memos: { memo: string; date: string }[]
  first_date: string
  latest_date: string
}

export interface InsightParent {
  parent_id: string
  cs_count: number
  categories: string[]
  memos: { memo: string; date: string; category: string }[]
  latest_date: string
}

export interface CategoryDailyRow { day: string; main: string | null; sub: string | null; count: number }

// keyword_trend 엔드포인트 응답 한 행.
// growth_rate = this_week / max(avg_per_week, 1). is_new = 직전 4주 동안 0회 등장.
export interface KeywordTrendRow {
  word: string
  this_week: number
  avg_per_week: number
  growth_rate: number
  is_new: boolean
}

export interface KeywordMemoRow {
  memo: string
  date: string
}

export interface CollectionLatest {
  collected_at: string
  target_date: string
  count: number
  status: string
}

export interface JiraBug {
  key: string
  summary: string
  status: string
  created_at: string
  cs_count: number
  cs_keywords: string
  synced_at: string | null
}

export interface JiraBugMemo {
  created_date: string
  category_main: string | null
  category_sub: string | null
  call_memo: string
}

export interface AnalysisGroup {
  sub: string
  count: number
  memos: { id: number; text: string }[]
}

export interface RiskRow {
  main: string
  sub: string
  count: number
  main_total?: number
  summary: string
  memos: { id: number; text: string }[]
  analysis_groups: AnalysisGroup[]
  insufficient_data: boolean
}

export interface OllamaSettings {
  url: string
  presets: string[]
}

export interface PeakBucket {
  bucket_start: string
  bucket_end: string
  bucket_count: number
  avg_count: number
  pattern: string
  summary: string
  has_pattern: boolean
}

export interface DailyReport {
  report_date: string
  generated_at: string
  total_count: number
  risk_total: number
  risk_rows: RiskRow[]
  peak_bucket?: PeakBucket
  hourly: [number, number][]
}

export interface WeeklyDayCount  { date: string; count: number; is_weekend: boolean }
export interface WeeklySqiDay    { date: string; sqi: number }
export interface WeeklyCatItem   { main: string; count: number }
export interface WeeklyPeakDay   { date: string; count: number }
export interface WeeklyRiskRow   { main: string; count: number; summary: string }
// risk_stack: [{ date, "네트워크·앱 오류": number, "기기·하드웨어 오류": number, ... }]
export type WeeklyRiskStackDay = { date: string } & Record<string, number>

export interface WeeklyMemoItem  { date: string; sub: string; text: string }
export interface WeeklyMemosPage {
  memos: WeeklyMemoItem[]
  total: number
  page: number
  page_size: number
}

export interface WeeklyReport {
  week_start: string
  week_end: string
  generated_at: string
  total_weekday: number
  daily_avg: number
  risk_total: number
  daily_counts: WeeklyDayCount[]
  sqi_daily: WeeklySqiDay[]
  category_breakdown: WeeklyCatItem[]
  risk_stack: WeeklyRiskStackDay[]
  peak_daily: WeeklyPeakDay[]
  risk_rows: WeeklyRiskRow[]
  weekly_summary: string
}

// ── 어드민 URL 헬퍼 ──────────────────────────────────────────────
// 내부 어드민 페이지 URL을 생성한다. fetch 호출이 아니라 <a href> 링크용이므로
// api 객체가 아닌 별도 함수로 분리한다. URL 구조가 바뀌면 여기만 수정하면 된다.

export const adminStudentUrl = (studentId: string) =>
  `https://ad.wink.co.kr/members/search/students/${studentId}/basic/read`

export const adminParentUrl = (parentId: string) =>
  `https://ad.wink.co.kr/members/member/parents/${parentId}/basic/read`

// ── 기본 fetcher ─────────────────────────────────────────────────

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<T>
}

async function post<T>(url: string): Promise<T> {
  const r = await fetch(url, { method: 'POST' })
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<T>
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<T>
}

// ── API 함수 ─────────────────────────────────────────────────────

export const api = {
  fetchHourly(startDate: string, endDate: string) {
    return get<BucketRow[]>(`/api/stats/hourly_range?start_date=${startDate}&end_date=${endDate}`)
  },

  fetchDaily(targetDate: string, period = 'week') {
    return get<DailyRow[]>(`/api/stats/daily?target_date=${targetDate}&period=${period}`)
  },

  fetchWeekly(targetDate: string) {
    return get<WeeklyRow[]>(`/api/stats/weekly?target_date=${targetDate}`)
  },

  fetchMonthly(targetDate: string) {
    return get<MonthlyRow[]>(`/api/stats/monthly?target_date=${targetDate}`)
  },

  fetchCategory(params: {
    startDate?: string
    endDate?: string
    targetDate?: string
    period?: string
    bucket?: string
  }) {
    const p = new URLSearchParams()
    if (params.startDate) p.set('start_date', params.startDate)
    if (params.endDate)   p.set('end_date',   params.endDate)
    if (params.targetDate) p.set('target_date', params.targetDate)
    if (params.period)    p.set('period',      params.period)
    if (params.bucket)    p.set('bucket',      params.bucket)
    return get<CategoryRow[]>(`/api/stats/category?${p}`)
  },

  fetchIssues(params: {
    startDate?: string
    endDate?: string
    targetDate?: string
    period?: string
    bucket?: string
    categoryMain?: string
    categorySub?: string
    unclassified?: boolean
    limit?: number
    offset?: number
  }) {
    const p = new URLSearchParams()
    if (params.startDate)    p.set('start_date',     params.startDate)
    if (params.endDate)      p.set('end_date',       params.endDate)
    if (params.targetDate)   p.set('target_date',    params.targetDate)
    if (params.period)       p.set('period',         params.period)
    if (params.bucket)       p.set('bucket',         params.bucket)
    if (params.categoryMain) p.set('category_main',  params.categoryMain)
    if (params.categorySub)  p.set('category_sub',   params.categorySub)
    if (params.unclassified) p.set('unclassified',   '1')
    if (params.limit  != null) p.set('limit',  String(params.limit))
    if (params.offset != null) p.set('offset', String(params.offset))
    return get<IssueList>(`/api/issues?${p}`)
  },

  fetchWingsTickets() {
    return get<{ data: InsightWings[]; updated_at: string | null }>('/api/insights/wings_tickets')
  },

  fetchRepeatParents() {
    return get<{ data: InsightParent[]; updated_at: string | null }>('/api/insights/repeat_parents')
  },

  refreshInsights() {
    return post<{ status: string }>('/api/insights/refresh')
  },

  fetchLatestCollection() {
    return get<CollectionLatest>('/api/collection/latest')
  },

  fetchCategoryDaily(targetDate: string) {
    return get<CategoryDailyRow[]>(`/api/stats/category_daily?target_date=${targetDate}`)
  },

  fetchKeywordTrend(targetDate: string) {
    return get<KeywordTrendRow[]>(`/api/stats/keyword_trend?target_date=${targetDate}`)
  },

  fetchKeywordMemos(keyword: string, targetDate: string) {
    return get<KeywordMemoRow[]>(`/api/stats/keyword_memos?keyword=${encodeURIComponent(keyword)}&target_date=${targetDate}`)
  },

  fetchJiraBugs() {
    return get<{ data: JiraBug[] }>('/api/jira/bugs')
  },

  fetchJiraBugMemos(key: string) {
    return get<{ data: JiraBugMemo[] }>(`/api/jira/bugs/${encodeURIComponent(key)}/memos`)
  },

  syncJiraBugs() {
    return post<{ status: string }>('/api/jira/sync')
  },

  fetchDailyReport(date: string) {
    return get<DailyReport>(`/api/report/daily?date=${date}`)
  },

  generateDailyReportStats(date: string) {
    return post<DailyReport>(`/api/report/daily/generate-stats?date=${date}`)
  },

  generateDailyReport(date: string) {
    return post<DailyReport>(`/api/report/daily/generate?date=${date}`)
  },

  analyzeDailyCategory(date: string, main: string) {
    return post<{ main: string; sub: string; count: number; summary: string; insufficient_data: boolean; prompt_section: string }>(
      `/api/report/daily/analyze-category?date=${date}&main=${encodeURIComponent(main)}`
    )
  },

  analyzeDailyPeak(date: string) {
    return post<{ bucket_start: string; bucket_end: string; bucket_count: number; avg_count: number; pattern: string; summary: string; has_pattern: boolean; insufficient_data: boolean; prompt_section: string }>(
      `/api/report/daily/analyze-peak?date=${date}`
    )
  },

  fetchWeeklyReport(weekStart: string) {
    return get<WeeklyReport>(`/api/report/weekly?week_start=${weekStart}`)
  },

  generateWeeklyReportStats(weekStart: string) {
    return post<WeeklyReport>(`/api/report/weekly/generate-stats?week_start=${weekStart}`)
  },

  generateWeeklyReport(weekStart: string) {
    return post<WeeklyReport>(`/api/report/weekly/generate?week_start=${weekStart}`)
  },

  analyzeWeeklyCategory(weekStart: string, main: string) {
    return post<{ main: string; count: number; summary: string; insufficient_data: boolean }>(
      `/api/report/weekly/analyze-category?week_start=${weekStart}&main=${encodeURIComponent(main)}`
    )
  },

  analyzeWeeklySummary(weekStart: string) {
    return post<{ summary: string }>(
      `/api/report/weekly/analyze-summary?week_start=${weekStart}`
    )
  },

  fetchWeeklyMemos(weekStart: string, main: string, page: number) {
    return get<WeeklyMemosPage>(`/api/report/weekly/memos?week_start=${weekStart}&main=${encodeURIComponent(main)}&page=${page}`)
  },

  fetchOllamaSettings() {
    return get<OllamaSettings>('/api/settings/ollama')
  },

  setOllamaUrl(url: string) {
    return postJson<{ url: string }>('/api/settings/ollama', { url })
  },
}
