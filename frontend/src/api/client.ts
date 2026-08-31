// 모든 백엔드 API 호출과 TypeScript 타입을 한 곳에 모은다. 컴포넌트는 직접 fetch를 쓰지 않고 이 모듈만 참조한다.
// 엔드포인트 경로·파라미터 변경이 생기면 이 파일만 수정하면 된다 (정책 9).
//
// [백엔드 주소 참고]
// 프론트(Firebase 등)와 백엔드(서버컴)가 서로 다른 origin으로 배포되므로, 모든 요청 앞에
// API_BASE(VITE_API_BASE_URL)를 붙인다. 로컬 개발처럼 값을 안 정해두면 빈 문자열이 붙어
// 지금까지와 동일하게 상대경로(/api/...)로 동작한다 — 즉 이 값은 프로덕션 빌드 시에만
// .env.production에 채우면 되고, 로컬 개발 흐름은 전혀 바뀌지 않는다.
const API_BASE = import.meta.env.VITE_API_BASE_URL || ''

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

// Wings 티켓 하나 = 한 가정의 개별 A/S 건 (여러 고객이 공유하지 않음). cs_count가 큰 건
// "이 가정이 이 문제로 CS를 여러 번 거쳤는데도 안 풀렸다"는 신호 — 미해결 버그 트래킹(원래
// 표)과 가정별 이탈 위험 섹션(카테고리 분포·주간 추이) 양쪽에서 이 타입을 그대로 같이 쓴다.
export interface InsightWings {
  ticket_id: string
  cs_count: number
  state?: string  // Wings API에서 조회한 실제 상태 (신규·진행 중·해결·요청취소 등). 토큰 미설정 시 undefined.
  memos: { memo: string; date: string }[]
  first_date: string
  latest_date: string
  parent_id: number | null
  category: string | null
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

export interface KeywordHistoryRow {
  word: string
  first_detected: string
  last_detected: string
  peak_date: string
  peak_count: number
  peak_growth: number
  latest_count: number
  latest_growth: number
  detection_days: number
  recent_detection_days: number
  auto_status: '지속 탐지' | '재탐지' | '신규 탐지' | '일회성 탐지' | '감소 추세' | '최근 미탐지'
}

export interface KeywordTrendDateRow {
  date: string
  this_week: number
  avg_per_week: number
  growth_rate: number
  is_new: boolean
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

export interface ChurnReasonExample {
  id: number
  created_date: string
  reason: string
}

export interface ChurnReasonBucket {
  name: string
  count: number
  examples: ChurnReasonExample[]
}

export interface ChurnReasonStats {
  total: number
  buckets: ChurnReasonBucket[]
}

export interface DeviceSwapExample {
  id: number
  created_date: string
  seonchulgo: boolean
  reason: string
}

export interface DeviceSwapModel {
  model: string
  count: number
  examples: DeviceSwapExample[]
}

export interface DeviceSwapReasonExample {
  id: number
  created_date: string
  reason: string
}

export interface DeviceSwapReason {
  name: string
  count: number
  tier: 'clear' | 'needs_review'
  examples: DeviceSwapReasonExample[]
}

export interface DeviceSwapStats {
  total: number
  seonchulgo_count: number
  normal_count: number
  models: DeviceSwapModel[]
  reasons: DeviceSwapReason[]
}

export interface RetentionOfferExample {
  id: number
  created_date: string
  memo: string
}

export interface RetentionOffer {
  name: string
  count: number
  examples: RetentionOfferExample[]
}

export interface RetentionStats {
  defense_count: number
  confirmed_count: number
  save_rate: number
  unlabeled_count: number
  offers: RetentionOffer[]
}

export interface AnalysisGroup {
  sub: string
  count: number
  memos: { id: number; text: string }[]
}

// Gemma 요약 문장 중 건수·비율 기준 1위 카테고리 — 화면에서 그 부분만 굵게 강조하는 데 쓴다.
// 요약은 자유 문장이라 어디가 1위인지 프론트가 알 수 없어서, 백엔드가 이미 계산해둔 값을 그대로 받는다.
export interface TopCategory {
  name: string
  count: number
  pct: number
}

export interface RiskRow {
  main: string
  sub: string
  count: number
  main_total?: number
  subs?: { sub: string; count: number; memos?: { id: number; text: string }[] }[]
  summary: string
  memos: { id: number; text: string }[]
  analysis_groups: AnalysisGroup[]
  insufficient_data: boolean
  gemma_error?: string | null
  top_category?: TopCategory | null
}

export interface GemmaSettings {
  url: string
  presets: string[]
}

export interface AdminVerifyResult { ok: boolean; token?: string }
export interface CollectionStatus { enabled: boolean }
export interface CollectionDailyCount { day: string; count: number }
export interface CollectionLogEntry {
  id: number
  collected_at: string
  count_fetched: number
  status: string
  message: string
  last_id: number | null
  end_id: number | null
  source: string | null
}

export interface AuditLogEntry {
  id: number
  created_at: string
  action: string
  detail: string
  mode: 'manual' | 'auto'
}

// 보고서 메일링 설정. report_type별로 하나씩(daily/weekly) 관리 페이지("메일링 관리")에서
// 조회·저장한다. deadline_*는 "그 시각까지 보고서가 만들어져 있어야 발송" 기준,
// send_*는 실제 발송 시각 — 서로 다른 시각으로 따로 설정 가능하다.
export interface MailSettings {
  report_type: 'daily' | 'weekly'
  enabled: boolean
  deadline_hour: number
  deadline_minute: number
  send_hour: number
  send_minute: number
  sender_email: string
  recipients: string[]
}

// 보고서 자동 생성 설정. report_type별로 하나씩(daily/weekly) 관리 페이지("자동화 관리")에서
// 조회·저장한다. 메일링과 달리 마감 시각·발신자·수신자 개념이 없어(생성은 그 자체가 첫
// 단계라 기다릴 대상이 없다) on/off + 생성 시각만 있다.
export type GenerationJobType = 'daily' | 'weekly' | 'wings_refresh' | 'repeat_parents_refresh'

export interface GenerationSettings {
  report_type: GenerationJobType
  enabled: boolean
  generate_hour: number
  generate_minute: number
}

// Gemma 프롬프트 편집. prompt_key별로(daily_category/daily_peak/weekly_category/weekly_summary)
// 관리 페이지("자동화 관리")에서 조회·저장한다. fields는 이 프롬프트에 실제로 전달되는 데이터
// 목록과, 프롬프트 규칙이 그 데이터를 쓰라고 지시하는지 여부(used: true=명시적 지시,
// 'partial'=포괄적 지시 범위 안, false=지시 없음)를 담는다 — 백엔드가 코드와 대조해서
// 미리 정리해둔 값이라 그대로 표시만 한다.
export interface PromptField {
  field: string
  desc: string
  used: boolean | 'partial'
  note?: string
}

export interface PromptCatalogItem {
  key: string
  report_type: 'daily' | 'weekly'
  order: number
  label: string
  description: string
  fields: PromptField[]
  shared_notice?: string | null
  customized: boolean
}

export interface PromptSettingsData {
  prompt_key: string
  prompt_text: string
  default_text: string
  customized: boolean
}

export interface PeakBucket {
  bucket_start: string
  bucket_end: string
  bucket_count: number
  avg_count: number
  pattern: string
  summary: string
  has_pattern: boolean
  gemma_error?: string | null
  top_category?: TopCategory | null
}

export interface AnomalyBucket {
  bucket_start: string
  bucket_end: string
  bucket_count: number
  peak_count: number
  pattern: string
  summary: string
  has_pattern: boolean
  gemma_error?: string | null
  top_category?: TopCategory | null
}

export interface DailyReport {
  report_date: string
  generated_at: string
  total_count: number
  risk_total: number
  prev_total_count?: number | null
  prev_risk_total?: number | null
  risk_rows: RiskRow[]
  peak_bucket?: PeakBucket | null
  anomaly_bucket?: AnomalyBucket | null
  hourly: [number, number][]
}

// GET /api/report/daily/generate-status 응답. running=false면 지금 진행 중인 생성이 없다는 뜻
// (완료됐거나 애초에 시작 안 함) — label/step/total은 running일 때만 의미 있다.
export interface DailyReportProgress {
  running: boolean
  label?: string | null
  step?: number
  total?: number
}

export interface WeeklyDayCount  { date: string; count: number; is_weekend: boolean }
export interface WeeklySqiDay    { date: string; sqi: number }
export interface WeeklyCatItem   { main: string; count: number }
export interface WeeklyPeakDay   { date: string; count: number }
export interface WeeklyRiskRow   { main: string; count: number; summary: string; gemma_error?: string | null }
// risk_stack: [{ date, "네트워크·앱 오류": number, "기기·하드웨어 오류": number, ... }]
export type WeeklyRiskStackDay = { date: string } & Record<string, number>

export interface WingsRepeatTrendPoint { week_start: string; new_count: number; stale_count: number }

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
  prev_total_weekday?: number | null
  prev_risk_total?: number | null
  prev_daily_avg?: number | null
  daily_counts: WeeklyDayCount[]
  sqi_daily: WeeklySqiDay[]
  category_breakdown: WeeklyCatItem[]
  risk_stack: WeeklyRiskStackDay[]
  risk_sub_stack?: Record<string, Array<{ date: string } & Record<string, number>>>
  risk_sub_stack_prev?: Record<string, Array<{ date: string } & Record<string, number>>>
  peak_daily: WeeklyPeakDay[]
  risk_rows: WeeklyRiskRow[]
  wings_repeat_new_count?: number | null
  wings_repeat_stale_count?: number | null
  prev_wings_repeat_new_count?: number | null
  prev_wings_repeat_stale_count?: number | null
  weekly_summary: string
  weekly_summary_error?: string | null
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
  const r = await fetch(`${API_BASE}${url}`)
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<T>
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(`${API_BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<T>
}

// 관리자 인증 실패(401/403) 감지 콜백. 서버가 재시작되면 토큰이 메모리에서 사라져 죽는데,
// useAdmin.tsx의 AdminProvider가 여기에 logout()을 등록해두면 그 순간 바로 자동 로그아웃
// 처리된다 — 예전엔 사용자가 수동으로 "관리자 모드 끄기"를 눌러야만 재로그인 화면이 떴다.
let onAdminAuthError: (() => void) | null = null
export function setAdminAuthErrorHandler(fn: (() => void) | null) {
  onAdminAuthError = fn
}

// 관리자 전용 엔드포인트 호출용. X-Admin-Token 헤더에 useAdmin()의 세션 토큰을 실어 보낸다.
async function postJsonAdmin<T>(url: string, body: unknown, token: string): Promise<T> {
  const r = await fetch(`${API_BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
    body: JSON.stringify(body),
  })
  if (r.status === 401 || r.status === 403) onAdminAuthError?.()
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<T>
}

// 관리자 전용 POST 엔드포인트(요청 본문 없음) 호출용 (예: 보고서 생성 시작).
async function postAdmin<T>(url: string, token: string): Promise<T> {
  const r = await fetch(`${API_BASE}${url}`, { method: 'POST', headers: { 'X-Admin-Token': token } })
  if (r.status === 401 || r.status === 403) onAdminAuthError?.()
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<T>
}

// 관리자 전용 GET 엔드포인트 호출용 (예: 감사 로그 조회).
async function getAdmin<T>(url: string, token: string): Promise<T> {
  const r = await fetch(`${API_BASE}${url}`, { headers: { 'X-Admin-Token': token } })
  if (r.status === 401 || r.status === 403) onAdminAuthError?.()
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<T>
}

// 관리자 전용 DELETE 엔드포인트 호출용 (예: 메일링 설정 초기화).
async function deleteAdmin<T>(url: string, token: string): Promise<T> {
  const r = await fetch(`${API_BASE}${url}`, { method: 'DELETE', headers: { 'X-Admin-Token': token } })
  if (r.status === 401 || r.status === 403) onAdminAuthError?.()
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
    buckets?: string[]
    q?: string
  }) {
    const p = new URLSearchParams()
    if (params.startDate) p.set('start_date', params.startDate)
    if (params.endDate)   p.set('end_date',   params.endDate)
    if (params.targetDate) p.set('target_date', params.targetDate)
    if (params.period)    p.set('period',      params.period)
    if (params.buckets?.length) p.set('bucket', params.buckets.join(','))
    if (params.q)         p.set('q',           params.q)
    return get<CategoryRow[]>(`/api/stats/category?${p}`)
  },

  fetchIssues(params: {
    startDate?: string
    endDate?: string
    targetDate?: string
    period?: string
    buckets?: string[]
    q?: string
    categoryMain?: string
    categorySub?: string
    subs?: string[]
    unclassified?: boolean
    limit?: number
    offset?: number
  }) {
    const p = new URLSearchParams()
    if (params.startDate)    p.set('start_date',     params.startDate)
    if (params.endDate)      p.set('end_date',       params.endDate)
    if (params.targetDate)   p.set('target_date',    params.targetDate)
    if (params.period)       p.set('period',         params.period)
    if (params.buckets?.length) p.set('bucket',      params.buckets.join(','))
    if (params.q)            p.set('q',              params.q)
    if (params.categoryMain) p.set('category_main',  params.categoryMain)
    if (params.subs?.length) p.set('subs',           params.subs.join(','))
    else if (params.categorySub) p.set('category_sub', params.categorySub)
    if (params.unclassified) p.set('unclassified',   '1')
    if (params.limit  != null) p.set('limit',  String(params.limit))
    if (params.offset != null) p.set('offset', String(params.offset))
    return get<IssueList>(`/api/issues?${p}`)
  },

  fetchIssueSubs(categoryMain: string, startDate: string, endDate: string) {
    const p = new URLSearchParams({ category_main: categoryMain, start_date: startDate, end_date: endDate })
    return get<{ subs: string[] }>(`/api/issues/subs?${p}`)
  },

  fetchWingsTickets() {
    return get<{ data: InsightWings[]; updated_at: string | null }>('/api/insights/wings_tickets')
  },

  fetchWingsSummary() {
    return get<{ total: number; resolved: number; updated_at: string | null }>('/api/insights/wings_summary')
  },

  fetchRepeatParents() {
    return get<{ data: InsightParent[]; updated_at: string | null }>('/api/insights/repeat_parents')
  },

  refreshWingsInsights(token: string) {
    return postAdmin<{ status: string }>('/api/insights/refresh/wings', token)
  },

  refreshRepeatParentsInsights(token: string) {
    return postAdmin<{ status: string }>('/api/insights/refresh/repeat_parents', token)
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

  fetchKeywordHistory(days = 30) {
    return get<KeywordHistoryRow[]>(`/api/stats/keyword_history?days=${days}`)
  },

  fetchKeywordTrendDates(keyword: string, days = 30) {
    return get<KeywordTrendDateRow[]>(`/api/stats/keyword_trend_dates?keyword=${encodeURIComponent(keyword)}&days=${days}`)
  },

  fetchJiraBugs() {
    return get<{ data: JiraBug[] }>('/api/jira/bugs')
  },

  fetchChurnReasons() {
    return get<ChurnReasonStats>('/api/insights/churn_reasons')
  },

  fetchDeviceSwaps() {
    return get<DeviceSwapStats>('/api/insights/device_swaps')
  },

  fetchRetentionStats() {
    return get<RetentionStats>('/api/insights/retention')
  },

  fetchJiraBugMemos(key: string) {
    return get<{ data: JiraBugMemo[] }>(`/api/jira/bugs/${encodeURIComponent(key)}/memos`)
  },

  syncJiraBugs(token: string) {
    return postAdmin<{ status: string }>('/api/jira/sync', token)
  },

  fetchDailyReport(date: string) {
    return get<DailyReport>(`/api/report/daily?date=${date}`)
  },

  analyzeDailyCategory(date: string, main: string, token: string) {
    return postAdmin<{ main: string; sub: string; count: number; summary: string; insufficient_data: boolean; gemma_error?: string | null; prompt_section: string }>(
      `/api/report/daily/analyze-category?date=${date}&main=${encodeURIComponent(main)}`, token
    )
  },

  analyzeDailyPeak(date: string, token: string) {
    return postAdmin<PeakBucket | null>(`/api/report/daily/analyze-peak?date=${date}`, token)
  },

  startDailyReportGeneration(date: string, token: string) {
    return postAdmin<{ started: boolean; reason?: string }>(`/api/report/daily/generate?date=${date}`, token)
  },

  fetchDailyReportGenerateStatus(date: string) {
    return get<DailyReportProgress>(`/api/report/daily/generate-status?date=${date}`)
  },

  fetchLatestDailyReport() {
    return get<DailyReport>('/api/report/daily/latest')
  },

  fetchWeeklyReport(weekStart: string) {
    return get<WeeklyReport>(`/api/report/weekly?week_start=${weekStart}`)
  },

  fetchWeeklyReportLatest() {
    return get<WeeklyReport>('/api/report/weekly/latest')
  },

  generateWeeklyReportStats(weekStart: string, token: string) {
    return postAdmin<WeeklyReport>(`/api/report/weekly/generate-stats?week_start=${weekStart}`, token)
  },

  generateWeeklyReport(weekStart: string, token: string) {
    return postAdmin<WeeklyReport>(`/api/report/weekly/generate?week_start=${weekStart}`, token)
  },

  analyzeWeeklyCategory(weekStart: string, main: string, token: string) {
    return postAdmin<{ main: string; count: number; summary: string; insufficient_data: boolean; gemma_error?: string | null }>(
      `/api/report/weekly/analyze-category?week_start=${weekStart}&main=${encodeURIComponent(main)}`, token
    )
  },

  analyzeWeeklySummary(weekStart: string, token: string) {
    return postAdmin<{ summary: string; gemma_error?: string | null }>(
      `/api/report/weekly/analyze-summary?week_start=${weekStart}`, token
    )
  },

  fetchWeeklyMemos(weekStart: string, main: string, page: number, sub = '') {
    const p = new URLSearchParams({ week_start: weekStart, main, page: String(page) })
    if (sub) p.set('sub', sub)
    return get<WeeklyMemosPage>(`/api/report/weekly/memos?${p}`)
  },

  fetchWingsRepeatTrend(limitWeeks = 8) {
    return get<WingsRepeatTrendPoint[]>(`/api/report/weekly/wings_repeat_trend?limit_weeks=${limitWeeks}`)
  },

  fetchGemmaSettings() {
    return get<GemmaSettings>('/api/settings/gemma')
  },

  setGemmaUrl(url: string) {
    return postJson<{ url: string }>('/api/settings/gemma', { url })
  },

  verifyAdmin(passcode: string) {
    return postJson<AdminVerifyResult>('/api/admin/verify', { passcode })
  },

  fetchCollectionStatus() {
    return get<CollectionStatus>('/api/collection/status')
  },

  setCollectionEnabled(enabled: boolean, token: string) {
    return postJsonAdmin<CollectionStatus>('/api/collection/enabled', { enabled }, token)
  },

  fetchCollectionDailyCounts(days = 7) {
    return get<CollectionDailyCount[]>(`/api/collection/daily_counts?days=${days}`)
  },

  fetchCollectionLog() {
    return get<CollectionLogEntry[]>('/api/collection/log')
  },

  fetchCollectionLogOverLimit() {
    return get<CollectionLogEntry[]>('/api/collection/log/over-limit')
  },

  fetchCollectionLogIssues(logId: number) {
    return get<{ items: Issue[] }>(`/api/collection/log/${logId}/issues`)
  },

  fetchAuditLog(token: string, limit = 200) {
    return getAdmin<AuditLogEntry[]>(`/api/audit/log?limit=${limit}`, token)
  },

  fetchMailSettings(reportType: 'daily' | 'weekly', token: string) {
    return getAdmin<MailSettings>(`/api/mail-settings?report_type=${reportType}`, token)
  },

  saveMailSettings(settings: MailSettings, token: string) {
    return postJsonAdmin<MailSettings>('/api/mail-settings', settings, token)
  },

  resetMailSettings(reportType: 'daily' | 'weekly', token: string) {
    return deleteAdmin<MailSettings>(`/api/mail-settings?report_type=${reportType}`, token)
  },

  testMailSend(reportType: 'daily' | 'weekly', token: string, recipients: string[], date?: string) {
    const dateQ = date ? `&date=${date}` : ''
    const toQ = `&to=${encodeURIComponent(recipients.join(','))}`
    return postJsonAdmin<{ triggered: boolean }>(`/api/mail-settings/test?report_type=${reportType}${dateQ}${toQ}`, {}, token)
  },

  fetchGenerationSettings(reportType: GenerationJobType, token: string) {
    return getAdmin<GenerationSettings>(`/api/generation-settings?report_type=${reportType}`, token)
  },

  saveGenerationSettings(settings: GenerationSettings, token: string) {
    return postJsonAdmin<GenerationSettings>('/api/generation-settings', settings, token)
  },

  resetGenerationSettings(reportType: GenerationJobType, token: string) {
    return deleteAdmin<GenerationSettings>(`/api/generation-settings?report_type=${reportType}`, token)
  },

  fetchPromptCatalog(reportType: 'daily' | 'weekly', token: string) {
    return getAdmin<PromptCatalogItem[]>(`/api/prompt-settings/catalog?report_type=${reportType}`, token)
  },

  fetchPromptSettings(promptKey: string, token: string) {
    return getAdmin<PromptSettingsData>(`/api/prompt-settings?prompt_key=${promptKey}`, token)
  },

  savePromptSettings(promptKey: string, promptText: string, token: string) {
    return postJsonAdmin<PromptSettingsData>('/api/prompt-settings', { prompt_key: promptKey, prompt_text: promptText }, token)
  },

  resetPromptSettings(promptKey: string, token: string) {
    return deleteAdmin<PromptSettingsData>(`/api/prompt-settings?prompt_key=${promptKey}`, token)
  },
}
