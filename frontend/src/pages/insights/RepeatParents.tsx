// 학부모 반복 상담 인사이트 페이지. 백엔드(compute_repeat_parents)는 최근 180일 내 동일
// 학부모가 3회 이상 상담한 목록을 후보로 넘겨주지만, 이 페이지의 초점은 "최근 3개월 내에
// 무슨 이슈가 있었나"라 90일보다 오래된 메모는 getQualifyingMemos()에서 전부 걸러낸다 —
// 자격 판정(3회 이상)·상담 건수·유형 분포·최초 상담·차트가 전부 이 필터링된 값만 쓰므로
// 화면 전체가 항상 "최근 3개월 데이터만"으로 일관된다. 그 결과 백엔드 기준(180일)으로는
// 3회 이상이어도 최근 3개월 안에 3건이 안 되면 이 페이지에는 더 이상 잡히지 않는다.
//
// 이 페이지는 "학부모가 상담을 얼마나 반복했나"가 목적이라, 일별·주간 보고서·SQI가 쓰는 좁은
// 리스크 카테고리(기술적 결함 위주)로 한정하지 않고 "기타"까지 포함한 전체 카테고리(9개
// 대분류)를 대상으로 한다 — categories.ts 상단 주석 참고.
//
// 상담 패턴을 동일 유형 연속 상담(시간순으로 인접한 두 상담이 정확히 같은 카테고리) · 7일
// 이내 재상담 · 복합 이슈 상담 3개 축으로 나눠 카드로 보여주고, 카드를 클릭하면 그 조건에
// 맞는 학부모만 표가 필터링된다 — WingsTickets.tsx의 cardFilter와 같은 패턴이지만, 페이지
// 간 직접 참조는 하지 않고(정책 8) 이 파일 안에서 새로 구현했다.
//
// 상단: KPI 카드 4개(반복 상담 학부모/동일 유형 연속 상담/7일 이내 재상담/복합 이슈 상담, 전체
// 3개월 기준) + 반복 상담 유형 분포 차트("대분류 > 소분류" 단위, 막대 클릭 시 모달) → 대분류
// 필터 버튼(9개 대분류) → 상세 테이블(컬럼 순서는 WingsTickets.tsx를 따름: 학부모번호 · 상담
// 유형("대분류 > 소분류" 단위) · 상담 건수 · 상담 메모 · 최초 상담 · 마지막 상담, 헤더 클릭
// 정렬 + 페이지네이션)
//
// 의존: api/client.ts (InsightParent), api/categories.ts (FILTER_TREE)
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Chart from 'chart.js/auto'
import { api, adminParentUrl, type InsightParent } from '../../api/client'
import { FILTER_TREE } from '../../api/categories'
import { useAdmin } from '../../hooks/useAdmin'

// KPI 카드 상단 컬러 바 — 반복 Wings 티켓과 달리 카드별로 색을 다르게 주지 않고 전부 이 한 색만
// 써서(정적인 느낌 요청) 화려하지 않게 유지한다. 클릭 시 필터링되는 동작은 Wings와 동일하다.
const NAVY = '#1e3c72'

const CATEGORY_COLORS: Record<string, string> = {
  '네트워크·앱 오류':   '#3b82f6',
  '기기·하드웨어 오류': '#f59e0b',
  '미납·결제':          '#ef4444',
  '해지·유지 상담':     '#8b5cf6',
  '교재·물류·배송':     '#10b981',
  '체험 관련':          '#06b6d4',
  '계정·서비스':        '#ec4899',
  '윙크북스':           '#6366f1',
  '기타':               '#64748b',
}

type ActiveFilter = { main: string | null; sub: string | null }

// ── 자격 판별 ─────────────────────────────────────────────────────────────────

// 이 페이지는 "학부모가 상담을 얼마나 반복했나"가 목적이라(categories.ts 상단 주석 참고),
// 일별·주간 보고서·SQI가 쓰는 리스크 카테고리(ALLOWED_MAIN/SPECIFIC)로 좁히지 않고 "기타"를
// 포함한 모든 카테고리를 대상으로 한다.
//
// 백엔드 집계(compute_repeat_parents)는 최근 180일치를 훑지만, 이 페이지는 "최근 3개월 내에
// 무슨 이슈가 있었나"가 초점이라 90일보다 오래된 메모는 아예 계산에서 제외한다 — 자격 판정
// (3회 이상)·상담 건수·유형 분포·최초 상담·차트가 전부 이 함수 하나를 거치므로, 여기서
// 걸러두면 화면 전체가 저절로 "최근 3개월 데이터만"으로 일관된다. 그 결과 어떤 학부모가 3개월
// 이전엔 3회 이상 상담했더라도 최근 3개월 안에 3건이 안 되면 더 이상 이 페이지에 잡히지 않는다
// (백엔드 자격 기준인 180일보다 프론트 표시 기준이 더 엄격해지는 셈).
const RECENT_ACTIVITY_WINDOW_DAYS = 90
function getQualifyingMemos(r: InsightParent) {
  const cutoff = Date.now() - RECENT_ACTIVITY_WINDOW_DAYS * 86400000
  return r.memos.filter(m => new Date(m.date).getTime() >= cutoff)
}

export function isQualified(r: InsightParent): boolean {
  return getQualifyingMemos(r).length >= 3
}

// ── 패턴 판별 (카드 3개) ──────────────────────────────────────────────────────

// 동일 유형 연속 상담: 시간순으로 바로 인접한 두 상담이 완전히 같은 이슈(대분류 > 소분류)인 경우가
// 있으면 true. 중간에 다른 이슈가 끼어 있으면 "재발"로 보지 않는다 — 대분류만 같으면(사이에
// 전혀 다른 소분류가 껴도) 반복으로 잡히던 예전 기준(동일 이슈 반복)의 허점을 보완한 것.
export function hasConsecutiveRepeat(r: InsightParent): boolean {
  const memos = [...getQualifyingMemos(r)].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  for (let i = 1; i < memos.length; i++) {
    if (memos[i].category === memos[i - 1].category) return true
  }
  return false
}

function getLastGapDays(r: InsightParent): number | null {
  const dates = getQualifyingMemos(r)
    .map(m => new Date(m.date).getTime())
    .sort((a, b) => b - a)
  if (dates.length < 2) return null
  return Math.floor((dates[0] - dates[1]) / 86400000)
}

// 7일 이내 재상담: 가장 최근 두 상담 사이 간격이 7일 이내인 경우.
export function hasRecentShortGap(r: InsightParent): boolean {
  const gap = getLastGapDays(r)
  return gap !== null && gap <= 7
}

export function isComplexIssue(r: InsightParent): boolean {
  const mains = new Set(getQualifyingMemos(r).map(m => m.category.split(' > ')[0]))
  return mains.size >= 3
}

// ── 카드 클릭 필터 ────────────────────────────────────────────────────────────

type CardFilter = 'all' | 'repeat' | 'shortGap' | 'complex'
const CARD_FILTER_VALUES: CardFilter[] = ['all', 'repeat', 'shortGap', 'complex']
const CARD_PREDICATE: Record<Exclude<CardFilter, 'all'>, (r: InsightParent) => boolean> = {
  repeat: hasConsecutiveRepeat,
  shortGap: hasRecentShortGap,
  complex: isComplexIssue,
}

// 지금 선택된 카드 하나의 기준만 보여준다 — 카드 이름이 바로 위 카드에 이미 나와 있으니
// 여기서는 접두어 없이 기준 문장만 적는다.
const CARD_DESCRIPTIONS: Record<CardFilter, string> = {
  all: '전체 상담 건수가 3회 이상인 학부모입니다.',
  repeat: '상담 이력 중 시간순으로 바로 이어진 두 건이 동일한 유형(대분류·소분류 일치)인 경우입니다.',
  shortGap: '가장 최근 두 건의 상담 간격이 7일 이내인 경우입니다(과거에 7일 이내 재상담이 있었더라도 최근 간격이 7일을 넘으면 해당하지 않음).',
  complex: '상담 이력에 서로 다른 대분류가 3개 이상 포함된 경우입니다.',
}

// ── 표에 쓸 상담 유형 목록 ("대분류 > 소분류" 단위 건수, 빈도순) ─────────────
// 카테고리 필터가 걸려 있으면 그 카테고리만 보여준다 — 필터를 걸어놓고도 표에는 그 학부모의
// 모든 유형이 다 나오면 정작 보고 싶은 유형이 다른 유형들 사이에 묻혀서 번잡해 보인다.

export function typesWithCounts(r: InsightParent, filter?: ActiveFilter): { category: string; count: number }[] {
  const counts: Record<string, number> = {}
  const memos = filter?.main ? getQualifyingMemos(r).filter(m => memoMatches(m.category, filter)) : getQualifyingMemos(r)
  memos.forEach(m => {
    counts[m.category] = (counts[m.category] ?? 0) + 1
  })
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count }))
}

// 최초 상담일 — 자격 조건을 만족하는 메모 중 가장 오래된 날짜. "이 학부모가 언제부터 이
// 문제를 겪기 시작했나"를 보여준다(Wings의 최초 상담과 같은 개념).
export function getFirstDate(r: InsightParent): string | null {
  const memos = getQualifyingMemos(r)
  if (!memos.length) return null
  return memos.reduce((earliest, m) => m.date < earliest ? m.date : earliest, memos[0].date)
}

// 문의 유형 분포 차트에서 막대("대분류 > 소분류") 클릭 시 모달에 띄울 행 목록 — 그 소분류에
// 해당하는 메모가 있는 학부모만, 그 기준 건수·최근 메모로 추려서 건수 내림차순 정렬한다.
export interface CategoryModalRow {
  parent_id: string
  count: number
  latestMemo: string
  latestDate: string
}

export function rowsForCategory(data: InsightParent[], category: string): CategoryModalRow[] {
  return data
    .map(r => {
      const memos = getQualifyingMemos(r)
        .filter(m => m.category === category)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      if (!memos.length) return null
      return { parent_id: r.parent_id, count: memos.length, latestMemo: memos[0].memo, latestDate: memos[0].date }
    })
    .filter((row): row is CategoryModalRow => row !== null)
    .sort((a, b) => b.count - a.count)
}

// ── 카테고리 필터 ─────────────────────────────────────────────────────────────

function memoMatches(category: string, f: ActiveFilter): boolean {
  if (!f.main) return true
  if (f.sub) return category === `${f.main} > ${f.sub}`
  return category.startsWith(`${f.main} > `)
}

export function getDisplayCount(r: InsightParent, filter: ActiveFilter): number {
  if (filter.main) return r.memos.filter(m => memoMatches(m.category, filter)).length
  return getQualifyingMemos(r).length
}

// ── 정렬 ──────────────────────────────────────────────────────────────────────

type SortKey = 'parent_id' | 'cs_count' | 'first_date' | 'latest_date'

function getSortValue(r: InsightParent, key: SortKey, filter: ActiveFilter): number | string {
  switch (key) {
    case 'parent_id': return r.parent_id
    case 'cs_count': return getDisplayCount(r, filter)
    case 'first_date': return getFirstDate(r) ?? ''
    case 'latest_date': return r.latest_date
  }
}

export function compareRows(a: InsightParent, b: InsightParent, key: SortKey, dir: 'asc' | 'desc', filter: ActiveFilter): number {
  const av = getSortValue(a, key, filter)
  const bv = getSortValue(b, key, filter)
  const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'ko')
  return dir === 'desc' ? -cmp : cmp
}

function SortableTh({
  label, sortKey: key, width, currentKey, currentDir, onSort,
}: {
  label: string; sortKey: SortKey; width?: number
  currentKey: SortKey; currentDir: 'asc' | 'desc'; onSort: (key: SortKey) => void
}) {
  const active = currentKey === key
  return (
    <th style={{ width, cursor: 'pointer', userSelect: 'none', fontSize: 16 }} onClick={() => onSort(key)}>
      {label}
      <span style={{ marginLeft: 3, color: active ? '#1a56db' : '#cbd5e1', fontWeight: active ? 700 : 400 }}>
        {active ? (currentDir === 'desc' ? '▼' : '▲') : '▼'}
      </span>
    </th>
  )
}

// 문의 유형 분포 차트의 막대 클릭 시 뜨는 모달 — WeeklyReport.tsx의 SeverityListModal과 같은
// 방식(가로 스크롤 없이 tableLayout:fixed + 컬럼별 고정폭, 50건씩 페이지네이션).
const CATEGORY_MODAL_PAGE_SIZE = 50

function CategoryBarModal({ category, rows, onClose }: { category: string; rows: CategoryModalRow[]; onClose: () => void }) {
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(rows.length / CATEGORY_MODAL_PAGE_SIZE))
  const pagedRows = rows.slice((page - 1) * CATEGORY_MODAL_PAGE_SIZE, page * CATEGORY_MODAL_PAGE_SIZE)

  const pager = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#64748b' }}>
      <button
        disabled={page <= 1}
        onClick={() => setPage(p => p - 1)}
        style={{
          border: '1px solid #e2e8f0', borderRadius: 6, padding: '4px 14px',
          background: '#fff', fontSize: 13,
          cursor: page <= 1 ? 'default' : 'pointer',
          color: page <= 1 ? '#cbd5e1' : '#374151',
        }}
      >이전</button>
      <span>{page} / {totalPages} 페이지 (총 {rows.length.toLocaleString()}명)</span>
      <button
        disabled={page >= totalPages}
        onClick={() => setPage(p => p + 1)}
        style={{
          border: '1px solid #e2e8f0', borderRadius: 6, padding: '4px 14px',
          background: '#fff', fontSize: 13,
          cursor: page >= totalPages ? 'default' : 'pointer',
          color: page >= totalPages ? '#cbd5e1' : '#475569',
        }}
      >다음</button>
    </div>
  )

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#fff', borderRadius: 16,
        width: '100%', maxWidth: 900, maxHeight: '90vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '18px 32px', borderBottom: '1px solid #e2e8f0',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#1e293b' }}>{category}</div>
            <div style={{ marginTop: 4, fontSize: 15, color: '#475569', fontWeight: 500 }}>
              최근 3개월 · 총 {rows.length}명
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#94a3b8', lineHeight: 1, padding: 4 }}
          >✕</button>
        </div>
        <div style={{ padding: '10px 32px', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
          {pager}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
              <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                {[['학부모번호', 110], ['상담 건수', 80], ['최근 메모', undefined], ['최근 상담', 150]].map(([h, w]) => (
                  <th key={h as string} style={{ width: w, padding: '10px 12px', textAlign: 'left', fontSize: 16, fontWeight: 700, color: '#64748b' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pagedRows.map(r => (
                <tr key={r.parent_id} style={{ borderBottom: '1px solid #f8fafc' }}>
                  <td style={{ padding: '9px 12px', fontSize: 15, verticalAlign: 'top' }}>
                    <a href={adminParentUrl(r.parent_id)} target="_blank" rel="noreferrer" style={{ color: '#1a56db', fontWeight: 600, textDecoration: 'none' }}>
                      {r.parent_id}
                    </a>
                  </td>
                  <td style={{ padding: '9px 12px', fontSize: 15, verticalAlign: 'top' }}>{r.count}건</td>
                  <td style={{ padding: '9px 12px', fontSize: 15, color: '#374151', lineHeight: 1.6, verticalAlign: 'top', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                    {r.latestMemo
                      ? r.latestMemo.split('\n').map((line, i) => <span key={i}>{i > 0 && <br />}{line}</span>)
                      : <span style={{ color: '#cbd5e1' }}>—</span>}
                  </td>
                  <td style={{ padding: '9px 12px', fontSize: 15, verticalAlign: 'top', whiteSpace: 'nowrap', color: '#94a3b8' }}>
                    {r.latestDate ? r.latestDate.slice(0, 16) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '12px 32px', borderTop: '1px solid #f1f5f9', flexShrink: 0 }}>
          {pager}
        </div>
      </div>
    </div>
  )
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export default function RepeatParents() {
  const { isAdmin, adminToken } = useAdmin()
  const [searchParams] = useSearchParams()
  const [data, setData]             = useState<InsightParent[]>([])
  const [updatedAt, setUpdatedAt]   = useState('')
  const [loading, setLoading]       = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter]         = useState<ActiveFilter>({ main: null, sub: null })
  const [expanded, setExpanded]     = useState<Set<string>>(new Set())
  // 주간보고서의 "반복 상담 학부모 현황" 카드(?filter=)로 들어온 경우 그 카드가 바로
  // 선택된 상태로 시작한다 — WingsTickets.tsx와 같은 패턴.
  const [cardFilter, setCardFilter] = useState<CardFilter>(() => {
    const f = searchParams.get('filter')
    return (CARD_FILTER_VALUES as string[]).includes(f ?? '') ? (f as CardFilter) : 'all'
  })
  const [sortKey, setSortKey]       = useState<SortKey>('cs_count')
  const [sortDir, setSortDir]       = useState<'asc' | 'desc'>('desc')
  const [pageSize, setPageSize]     = useState(50)
  const [page, setPage]             = useState(1)
  const [modalCategory, setModalCategory] = useState<string | null>(null)
  const [chartExpanded, setChartExpanded] = useState(false)

  const hbarCanvasRef = useRef<HTMLCanvasElement>(null)
  const hbarChartRef  = useRef<Chart | null>(null)
  const chartSectionRef = useRef<HTMLDivElement>(null)
  // 주간보고서 "반복 상담 학부모 현황" 카드(?filter=)를 눌러 들어온 경우 — 브라우저는 페이지
  // 이동 시 스크롤 위치를 초기화해주지 않아서, 주간보고서에서 한참 내려가 있던 위치 그대로
  // 이 페이지에 도착해 표 중간 어딘가에 놓이게 된다. 카드 링크로 들어온 최초 한 번만 차트
  // 위치로 스크롤해서 맞춰준다.
  const cameFromCardLink = useRef(searchParams.get('filter') !== null)

  // 펼친 상태(25개)에서 접으면 차트가 갑자기 짧아지면서 화면은 그 아래 콘텐츠를 보고 있게
  // 된다 — 접었을 때만 차트 카드 상단으로 스크롤해서 위치를 다시 맞춘다(펼칠 때는 아래로
  // 자연스럽게 늘어나니 필요 없다).
  function toggleChartExpanded() {
    setChartExpanded(prev => {
      const next = !prev
      if (!next) {
        requestAnimationFrame(() => chartSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
      }
      return next
    })
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (!loading && data.length > 0 && cameFromCardLink.current) {
      cameFromCardLink.current = false
      requestAnimationFrame(() => chartSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }, [loading, data])

  async function load() {
    setLoading(true)
    try {
      const res = await api.fetchRepeatParents()
      setData((res.data || []).filter(isQualified))
      setUpdatedAt(res.updated_at ? res.updated_at.slice(0, 16) : '')
      setFilter({ main: null, sub: null })
    } finally {
      setLoading(false)
    }
  }

  async function handleRefresh() {
    if (!adminToken) return
    setRefreshing(true)
    try {
      await api.refreshRepeatParentsInsights(adminToken)
      await load()
    } finally {
      setRefreshing(false)
    }
  }

  function handleCardClick(f: CardFilter) {
    setCardFilter(prev => prev === f ? 'all' : f)
  }

  function selectMain(main: string) {
    setFilter(prev => prev.main === main && !prev.sub ? { main: null, sub: null } : { main, sub: null })
    setExpanded(new Set())
  }

  function selectSub(main: string, sub: string) {
    setFilter(prev => prev.sub === sub ? { main, sub: null } : { main, sub })
    setExpanded(new Set())
  }

  function toggleExpand(parentId: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(parentId) ? next.delete(parentId) : next.add(parentId)
      return next
    })
  }

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  // ── 차트 (카드·카테고리 필터 영향 안 받음 — 항상 3개월 전체 기준의 개요) ─────

  const CHART_COLLAPSED_COUNT = 5

  useEffect(() => {
    if (loading || !data.length) return

    const catCount: Record<string, number> = {}
    data.forEach(p => {
      getQualifyingMemos(p).forEach(m => {
        catCount[m.category] = (catCount[m.category] ?? 0) + 1
      })
    })
    const sortedLabels = Object.keys(catCount).sort((a, b) => catCount[b] - catCount[a])
    const labels = chartExpanded ? sortedLabels : sortedLabels.slice(0, CHART_COLLAPSED_COUNT)

    // 소분류(">"  뒤쪽)만 16px·bold로, 대분류는 13px 그대로 두는 두 가지 글꼴 크기가 한 눈금
    // 라벨 안에 섞여야 해서 Chart.js 기본 눈금 렌더링으로는 안 되고, afterFit으로 축 폭을
    // 직접 재고 afterDraw에서 두 글꼴로 나눠 그리는 커스텀 플러그인이 필요하다
    // (WeeklyReport.tsx의 leftAlignedYTicksPlugin과 같은 방식) — 그리고 ticks.autoSkip을 꺼야
    // 라벨이 겹쳐 보인다고 판단해 절반을 건너뛰는 일이 없다(소분류 12개가 6개만 보이던 원인).
    const MAIN_FONT = '13px Pretendard, sans-serif'
    const SUB_FONT = 'bold 16px Pretendard, sans-serif'
    // Chart.js에서 afterFit은 플러그인 훅이 아니라 축(scale) 자체의 옵션으로만 인식된다 —
    // 플러그인 객체 안에 넣으면 조용히 무시돼서 축 폭이 0에 가깝게 잡히고 라벨이 아예 안
    // 그려진다(처음에 그렇게 됐던 원인). 반드시 scales.y.afterFit에 직접 둬야 한다.
    const subBoldYTicksPlugin = {
      id: 'subBoldYTicks',
      afterDraw: (chart: Chart) => {
        const yScale = chart.scales.y
        const ctx = chart.ctx
        ctx.save()
        ctx.textBaseline = 'middle'
        labels.forEach((label, i) => {
          const y = yScale.getPixelForTick(i)
          const rightEdge = yScale.right - 8
          const [main, sub] = label.split(' > ')
          if (sub) {
            const mainText = `${main} > `
            ctx.font = SUB_FONT
            const subWidth = ctx.measureText(sub).width
            ctx.font = MAIN_FONT
            const mainWidth = ctx.measureText(mainText).width
            const startX = rightEdge - subWidth - mainWidth
            ctx.textAlign = 'left'
            ctx.fillStyle = '#64748b'
            ctx.font = MAIN_FONT
            ctx.fillText(mainText, startX, y)
            ctx.fillStyle = '#1e293b'
            ctx.font = SUB_FONT
            ctx.fillText(sub, startX + mainWidth, y)
          } else {
            ctx.textAlign = 'right'
            ctx.fillStyle = '#374151'
            ctx.font = MAIN_FONT
            ctx.fillText(label, rightEdge, y)
          }
        })
        ctx.restore()
      },
    }

    // 막대 끝에 건수를 직접 표시 — WeeklyReport.tsx의 datalabels 플러그인과 같은 방식이지만
    // 가로 막대라 막대 위가 아니라 오른쪽 끝에, 세로 중앙 정렬로 그린다.
    const barEndLabelPlugin = {
      id: 'barEndLabel',
      afterDatasetsDraw: (chart: Chart) => {
        const { ctx } = chart
        chart.getDatasetMeta(0).data.forEach((bar, idx) => {
          const val = chart.data.datasets[0].data[idx] as number
          if (!val) return
          ctx.save()
          ctx.font = 'bold 13px Pretendard, sans-serif'
          ctx.fillStyle = '#374151'
          ctx.textAlign = 'left'
          ctx.textBaseline = 'middle'
          ctx.fillText(`${val.toLocaleString()}건`, bar.x + 6, bar.y)
          ctx.restore()
        })
      },
    }

    if (hbarCanvasRef.current) {
      hbarChartRef.current?.destroy()
      hbarChartRef.current = new Chart(hbarCanvasRef.current, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            data: labels.map(l => catCount[l]),
            backgroundColor: labels.map(l => CATEGORY_COLORS[l.split(' > ')[0]] ?? '#94a3b8'),
            borderRadius: 4,
            borderSkipped: false,
          }],
        },
        plugins: [subBoldYTicksPlugin, barEndLabelPlugin],
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          onClick: (_e, elements) => {
            if (elements.length === 0) return
            setModalCategory(labels[elements[0].index])
          },
          onHover: (ev, elements) => {
            const t = (ev.native?.target as HTMLElement) ?? undefined
            if (t) t.style.cursor = elements.length ? 'pointer' : 'default'
          },
          plugins: { legend: { display: false } },
          layout: { padding: { right: 40 } },
          scales: {
            x: { ticks: { stepSize: 50, font: { size: 13 }, color: '#374151' }, grid: { color: 'rgba(0,0,0,0.06)' }, min: 0 },
            y: {
              ticks: { display: false, autoSkip: false },
              grid: { display: false },
              afterFit: (scale: { ctx: CanvasRenderingContext2D; width: number }) => {
                const ctx = scale.ctx
                let maxWidth = 0
                labels.forEach(label => {
                  const [main, sub] = label.split(' > ')
                  ctx.font = MAIN_FONT
                  const mainWidth = ctx.measureText(sub ? `${main} > ` : label).width
                  ctx.font = SUB_FONT
                  const subWidth = sub ? ctx.measureText(sub).width : 0
                  maxWidth = Math.max(maxWidth, mainWidth + subWidth)
                })
                scale.width = Math.min(maxWidth + 14, 420)
              },
            },
          },
        },
      })
    }
  }, [loading, data, chartExpanded])

  useEffect(() => () => { hbarChartRef.current?.destroy() }, [])

  // 소분류 단위라 대분류일 때보다 막대 수가 늘어날 수 있어(최대 21개), 막대당 최소 높이를
  // 보장하도록 차트 높이를 라벨 수에 맞춰 늘린다. 접힌 상태에선 상위 5개만 그리므로 그만큼만.
  const chartAllCategoryCount = useMemo(() => {
    const set = new Set<string>()
    data.forEach(p => getQualifyingMemos(p).forEach(m => set.add(m.category)))
    return set.size
  }, [data])
  const chartCategoryCount = chartExpanded ? chartAllCategoryCount : Math.min(chartAllCategoryCount, CHART_COLLAPSED_COUNT)

  const chartTotalCount = useMemo(
    () => data.reduce((sum, p) => sum + getQualifyingMemos(p).length, 0),
    [data],
  )

  // ── 집계·필터·정렬·페이지네이션 ────────────────────────────────────────────

  const total         = data.length
  const repeatCount   = data.filter(hasConsecutiveRepeat).length
  const shortGapCount = data.filter(hasRecentShortGap).length
  const complexCount  = data.filter(isComplexIssue).length

  const cardFilteredRows = useMemo(
    () => cardFilter === 'all' ? data : data.filter(CARD_PREDICATE[cardFilter]),
    [data, cardFilter],
  )

  const filteredRows = useMemo(
    () => filter.main
      ? cardFilteredRows.filter(r => r.memos.some(m => memoMatches(m.category, filter)))
      : cardFilteredRows,
    [cardFilteredRows, filter],
  )

  const sortedRows = useMemo(
    () => [...filteredRows].sort((a, b) => compareRows(a, b, sortKey, sortDir, filter)),
    [filteredRows, sortKey, sortDir, filter],
  )

  useEffect(() => { setPage(1) }, [cardFilter, filter, pageSize])

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pagedRows = sortedRows.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  const cards: Array<{ key: CardFilter; label: string; value: number }> = [
    { key: 'all', label: '반복 상담 학부모', value: total },
    { key: 'repeat', label: '동일 유형 연속 상담', value: repeatCount },
    { key: 'shortGap', label: '7일 이내 재상담', value: shortGapCount },
    { key: 'complex', label: '복합 이슈 상담', value: complexCount },
  ]

  // ── 렌더 ──────────────────────────────────────────────────────────────────────

  return (
    <div className="container">

      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, marginBottom: 4, fontSize: 24, fontWeight: 700, color: '#1e293b' }}>학부모 반복 상담</h2>
        <p style={{ margin: 0, fontSize: 18, color: '#94a3b8' }}>
          최근 3개월 내 상담 기준입니다. 카드를 선택하면 해당 조건에 맞는 학부모만 확인할 수 있습니다.
        </p>
      </div>

      {!loading && data.length > 0 && (
        <>
          {/* KPI 카드 — 클릭하면 아래 표가 그 조건으로 필터링된다. "반복 상담 학부모"는 필터 해제(전체 보기) 역할 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 8 }}>
            {cards.map(card => {
              const active = cardFilter === card.key
              return (
                <button
                  key={card.key}
                  onClick={() => handleCardClick(card.key)}
                  style={{
                    textAlign: 'left', cursor: 'pointer', border: 'none', background: '#fff',
                    borderRadius: 12, padding: '20px 22px',
                    boxShadow: active
                      ? `0 0 0 2px ${NAVY}, 0 4px 14px ${NAVY}40`
                      : '0 1px 4px rgba(0,0,0,.07)',
                    borderLeft: `4px solid ${NAVY}`,
                  }}
                >
                  <div style={{
                    fontSize: 30, fontWeight: 700, color: '#64748b',
                    textTransform: 'uppercase', letterSpacing: '.6px', marginBottom: 8,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }} title={card.label}>
                    {card.label}
                  </div>
                  <div style={{ fontSize: 45, fontWeight: 800, color: '#0f172a', lineHeight: 1 }}>{card.value.toLocaleString()}명</div>
                </button>
              )
            })}
          </div>
          <div style={{ fontSize: 15, color: '#94a3b8', marginBottom: 16 }}>
            각 카드는 독립적인 기준이며, 하나의 학부모가 여러 카드에 중복 반영될 수 있습니다.
          </div>

          {/* 문의 유형 분포 차트 */}
          <div className="section-card" style={{ marginBottom: 16 }} ref={chartSectionRef}>
            <h2 style={{ fontSize: 20 }}>
              최근 3개월 반복 상담 유형 분포{' '}
              <span style={{ fontSize: 23, fontWeight: 700, color: '#1e293b' }}>(총 {chartTotalCount.toLocaleString()}건)</span>
            </h2>
            <div style={{ height: Math.max(180, chartCategoryCount * 34), position: 'relative' }}>
              {/* index.css의 전역 규칙 canvas{max-height:300px}이 이 차트엔 안 맞아서(카테고리
                  9개 대분류 전체로 늘어나 300px보다 훨씬 커야 함) 인라인 스타일로 덮어쓴다. */}
              <canvas ref={hbarCanvasRef} style={{ maxHeight: 'none' }} />
            </div>
            {chartAllCategoryCount > CHART_COLLAPSED_COUNT && (
              <button
                onClick={toggleChartExpanded}
                style={{ marginTop: 10, padding: '6px 14px', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', fontSize: 13, color: '#374151', cursor: 'pointer' }}
              >
                {chartExpanded ? '▲ 상위 5개만 보기' : `▼ 전체 ${chartAllCategoryCount}개 보기`}
              </button>
            )}
          </div>
        </>
      )}

      {/* 테이블 */}
      <div className="section-card">
        <div className="insight-toolbar">
          <span style={{ fontSize: 12, color: '#94a3b8' }}>
            {updatedAt && (
              <>
                <strong style={{ fontSize: 23, color: '#1e293b' }}>최근 3개월 기준</strong> · 업데이트: {updatedAt}
              </>
            )}
          </span>
          {isAdmin && (
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              style={{ padding: '8px 16px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, cursor: refreshing ? 'default' : 'pointer', fontSize: 13, fontWeight: 500, color: '#374151' }}
            >
              {refreshing ? '업데이트 중...' : '↻ 새로고침'}
            </button>
          )}
        </div>
        <div style={{ fontSize: 18, color: '#475569', marginBottom: 12, lineHeight: 1.6 }}>
          {CARD_DESCRIPTIONS[cardFilter]}
        </div>
        <div style={{ fontSize: 15, color: '#64748b', marginTop: -4, marginBottom: 12 }}>
          카테고리를 선택하면 해당 유형의 상담 내역만 필터링해 확인할 수 있습니다.
        </div>

        {!loading && data.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {FILTER_TREE.map(({ main }) => (
                <button
                  key={main}
                  className={`cat-filter-btn${filter.main === main ? ' active' : ''}`}
                  onClick={() => selectMain(main)}
                >
                  {main}
                </button>
              ))}
            </div>
            {filter.main && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, paddingLeft: 4 }}>
                {FILTER_TREE.find(t => t.main === filter.main)?.subs.map(sub => (
                  <button
                    key={sub}
                    className={`cat-filter-btn${filter.sub === sub ? ' active' : ''}`}
                    style={{ fontSize: 13, padding: '6px 14px', borderRadius: 6 }}
                    onClick={() => selectSub(filter.main!, sub)}
                  >
                    {sub}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: '#64748b' }}>페이지당</span>
          <select
            value={pageSize}
            onChange={e => setPageSize(Number(e.target.value))}
            style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, color: '#374151', background: '#fff' }}
          >
            {[10, 20, 50, 100].map(n => <option key={n} value={n}>{n}개씩</option>)}
          </select>
          <span style={{ fontSize: 20, fontWeight: 700, color: NAVY }}>총 {sortedRows.length.toLocaleString()}명</span>
          {filter.main && (
            <button
              onClick={() => setFilter({ main: null, sub: null })}
              style={{ padding: '5px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, color: '#64748b', background: '#fff', cursor: 'pointer' }}
            >
              초기화
            </button>
          )}
        </div>

        <div className="insight-table-wrap">
          {loading ? (
            <div className="loading">조회 중...</div>
          ) : !data.length ? (
            <div className="empty">해당 기간에 반복 상담 없음</div>
          ) : !sortedRows.length ? (
            <div className="empty">선택한 조건에 해당하는 학부모가 없습니다</div>
          ) : (
            <table style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <SortableTh label="학부모번호" sortKey="parent_id" width={110} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <th style={{ width: 170, fontSize: 16 }}>상담 유형</th>
                  <SortableTh label="상담 건수" sortKey="cs_count" width={80} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <th style={{ width: 290, fontSize: 16 }}>상담 메모</th>
                  <SortableTh label="최초 상담" sortKey="first_date" width={110} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                  <SortableTh label="마지막 상담" sortKey="latest_date" width={120} currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
                </tr>
              </thead>
              <tbody>
                {pagedRows.map(r => {
                  const isOpen   = expanded.has(r.parent_id)
                  const qMemos   = filter.main
                    ? r.memos.filter(m => memoMatches(m.category, filter))
                    : getQualifyingMemos(r)
                  const latestMemo = qMemos[0]?.memo ?? ''
                  const preview    = latestMemo.replace(/\n/g, ' ').slice(0, 50)

                  return (
                    <Fragment key={r.parent_id}>
                      <tr>
                        <td style={{ fontSize: 15, fontWeight: 600 }}>
                          {r.parent_id
                            ? <a href={adminParentUrl(r.parent_id)} target="_blank" rel="noreferrer" style={{ color: '#1a56db', textDecoration: 'none' }}>{r.parent_id}</a>
                            : <span style={{ color: '#94a3b8' }}>비회원</span>}
                        </td>
                        <td>
                          {typesWithCounts(r, filter).map(({ category, count }) => (
                            <div key={category} style={{ fontSize: 15, fontWeight: 600, color: CATEGORY_COLORS[category.split(' > ')[0]] ?? '#64748b', marginBottom: 3 }}>
                              {category} <span style={{ fontWeight: 400, color: '#94a3b8' }}>{count}건</span>
                            </div>
                          ))}
                        </td>
                        <td>
                          <span className="count-badge">{getDisplayCount(r, filter)}건</span>
                        </td>
                        <td style={{ color: '#64748b', fontSize: 15, maxWidth: 0 }}>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {preview}{latestMemo.length > 50 ? '…' : ''}
                          </div>
                          {qMemos.length > 0 && (
                            <button className="memo-toggle" onClick={() => toggleExpand(r.parent_id)} style={{ marginTop: 2 }}>
                              {isOpen ? '▼ 접기' : `▶ 전체 이력 (${qMemos.length}건)`}
                            </button>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap', color: '#64748b', fontSize: 15 }}>
                          {getFirstDate(r)?.slice(0, 16) ?? '—'}
                        </td>
                        <td style={{ whiteSpace: 'nowrap', color: '#64748b', fontSize: 15 }}>
                          {r.latest_date ? r.latest_date.slice(0, 16) : '—'}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={6} style={{ padding: 0 }}>
                            <div className="memo-expand-inner">
                              {qMemos.map((m, mi) => (
                                <div key={mi} className="memo-item">
                                  <div className="memo-item-date">{m.date ? m.date.slice(0, 16) : '—'} · {m.category || ''}</div>
                                  <div>{m.memo ? m.memo.split('\n').map((line, li) => <span key={li}>{li > 0 && <br />}{line}</span>) : ''}</div>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {!loading && sortedRows.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 12 }}>
            <span style={{ fontSize: 13, color: '#94a3b8' }}>총 {sortedRows.length.toLocaleString()}명 · {currentPage} / {totalPages}페이지</span>
            {totalPages > 1 && (
              <>
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}
                  style={{ padding: '6px 12px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', fontSize: 13, cursor: currentPage === 1 ? 'default' : 'pointer', color: currentPage === 1 ? '#cbd5e1' : '#475569' }}
                >
                  이전
                </button>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}
                  style={{ padding: '6px 12px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', fontSize: 13, cursor: currentPage === totalPages ? 'default' : 'pointer', color: currentPage === totalPages ? '#cbd5e1' : '#475569' }}
                >
                  다음
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {modalCategory && (
        <CategoryBarModal category={modalCategory} rows={rowsForCategory(data, modalCategory)} onClose={() => setModalCategory(null)} />
      )}
    </div>
  )
}
