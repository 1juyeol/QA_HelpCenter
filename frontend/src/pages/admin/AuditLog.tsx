// 관리자 전용 감사 로그 페이지. 대시보드에서 일어난 수동·자동 작업 이력을 최신순으로 보여주고,
// 검색어·카테고리·수동/자동·날짜 범위로 필터링한다 (GET /api/audit/log, require_admin 보호).
// 기록 대상(core/audit_log.py의 log_action 호출 지점 기준):
//   admin_login / admin_login_failed, collection_toggle, gemma_url_change, jira_sync,
//   insights_refresh(수동 /api/insights/refresh + 자동 아침보정 공통), keyword_trend_cache(자동, 매일 08:00),
//   daily_report_*(수동 API), daily_report_auto_generate(자동, 매일 00:30),
//   weekly_report_*(수동 API), weekly_report_auto_generate(자동, 매주 월 00:30)
// 조회(GET)성 액션은 남기지 않는다 — 상태를 바꾸는 작업만 기록 대상.
// 단, CS 상담 수집 5분 간격 정기 호출(하루 최대 146회)은 여기 안 남는다 — collection_log(별도
// 테이블)에 id 범위까지 훨씬 상세히 기록되고 "API 관리" 페이지에서 보이므로, 여기 중복 기록하면
// 하루 146줄이 쌓여 정작 중요한 로그인·설정변경 이력이 파묻히기 때문이다.
//
// mode('manual'/'auto')는 core/audit_log.py가 DB에 직접 저장해주는 값이라 여기서 추론하지 않는다.
// category는 순수 표시·필터용 매핑이라 이 파일 안에서만 관리한다 (DB 스키마 변경 불필요).
// 필터는 전부 프론트에서 처리한다 — 로그 양이 하루 몇십 건 수준이라 서버 쿼리 파라미터를
// 늘릴 필요가 없고, 나중에 로그가 훨씬 많아지면 그때 서버 필터로 옮기면 된다.
// 계정 시스템이 없어 "누가" 했는지는 안 남고 "언제·무엇을·수동인지 자동인지"만 남는다.
// 요청에 따라 담당자/캠페인 컬럼, 엑셀 내보내기는 넣지 않았다.
import { useEffect, useMemo, useState } from 'react'
import { api, type AuditLogEntry } from '../../api/client'
import { useAdmin } from '../../hooks/useAdmin'
import Badge from '../../components/Badge'

type Category = 'auth' | 'collection' | 'settings' | 'report'

const ACTION_LABEL: Record<string, string> = {
  admin_login: '관리자 로그인 성공',
  admin_login_failed: '관리자 로그인 실패',
  collection_toggle: 'CS 수집 on/off 전환',
  gemma_url_change: 'Gemma 서버 주소 변경',
  jira_sync: 'JIRA 동기화',
  insights_refresh: '인사이트 캐시 갱신',
  keyword_trend_cache: '키워드 트렌드 캐시 저장',
  keyword_trend_cache_failed: '키워드 트렌드 캐시 저장 실패',
  daily_report_generate_stats: '일별 보고서 통계 생성',
  daily_report_analyze_category: '일별 보고서 카테고리 분석',
  daily_report_analyze_peak: '일별 보고서 피크타임 분석',
  daily_report_auto_generate: '일별 보고서 자동 생성',
  daily_report_auto_generate_failed: '일별 보고서 자동 생성 실패',
  weekly_report_generate_stats: '주간 보고서 통계 생성',
  weekly_report_generate: '주간 보고서 전체 생성',
  weekly_report_analyze_category: '주간 보고서 카테고리 분석',
  weekly_report_analyze_summary: '주간 보고서 요약 분석',
  weekly_report_auto_generate: '주간 보고서 자동 생성',
  weekly_report_auto_generate_failed: '주간 보고서 자동 생성 실패',
}

const ACTION_CATEGORY: Record<string, Category> = {
  admin_login: 'auth',
  admin_login_failed: 'auth',
  collection_toggle: 'collection',
  gemma_url_change: 'settings',
  jira_sync: 'settings',
  insights_refresh: 'report',
  keyword_trend_cache: 'report',
  keyword_trend_cache_failed: 'report',
  daily_report_generate_stats: 'report',
  daily_report_analyze_category: 'report',
  daily_report_analyze_peak: 'report',
  daily_report_auto_generate: 'report',
  daily_report_auto_generate_failed: 'report',
  weekly_report_generate_stats: 'report',
  weekly_report_generate: 'report',
  weekly_report_analyze_category: 'report',
  weekly_report_analyze_summary: 'report',
  weekly_report_auto_generate: 'report',
  weekly_report_auto_generate_failed: 'report',
}

const CATEGORY_LABEL: Record<Category, string> = {
  auth: '인증',
  collection: 'CS 수집',
  settings: '설정',
  report: '보고서·인사이트',
}

const CATEGORY_COLOR: Record<Category, string> = {
  auth: '#7c3aed',
  collection: '#2563eb',
  settings: '#d97706',
  report: '#0d9488',
}

function CategoryBadge({ action }: { action: string }) {
  const category = ACTION_CATEGORY[action]
  if (!category) return null
  return <Badge color={CATEGORY_COLOR[category]}>{CATEGORY_LABEL[category]}</Badge>
}

function ModeBadge({ mode }: { mode: string }) {
  const isAuto = mode === 'auto'
  return (
    <Badge color={isAuto ? '#fde68a' : '#e2e8f0'} textColor={isAuto ? '#0f172a' : '#475569'}>
      {isAuto ? '자동' : '수동'}
    </Badge>
  )
}

export default function AuditLog() {
  const { isAdmin, adminToken } = useAdmin()
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null)
  const [error, setError] = useState(false)

  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<'all' | Category>('all')
  const [modeFilter, setModeFilter] = useState<'all' | 'manual' | 'auto'>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  useEffect(() => {
    if (!isAdmin || !adminToken) return
    api.fetchAuditLog(adminToken, 200)
      .then(setEntries)
      .catch(() => setError(true))
  }, [isAdmin, adminToken])

  const filtered = useMemo(() => {
    if (!entries) return []
    const q = search.trim().toLowerCase()
    return entries.filter(e => {
      const day = e.created_at.slice(0, 10)
      if (dateFrom && day < dateFrom) return false
      if (dateTo && day > dateTo) return false
      if (categoryFilter !== 'all' && ACTION_CATEGORY[e.action] !== categoryFilter) return false
      if (modeFilter !== 'all' && e.mode !== modeFilter) return false
      if (q) {
        const label = (ACTION_LABEL[e.action] ?? e.action).toLowerCase()
        const detail = (e.detail ?? '').toLowerCase()
        if (!label.includes(q) && !detail.includes(q)) return false
      }
      return true
    })
  }, [entries, search, categoryFilter, modeFilter, dateFrom, dateTo])

  if (!isAdmin) {
    return (
      <div className="section-card">
        <h2>🔒 관리자 전용 페이지</h2>
        <p style={{ color: '#64748b', fontSize: 13 }}>
          사이드바 하단의 잠금 아이콘에서 관리자 암호를 입력해야 볼 수 있습니다.
        </p>
      </div>
    )
  }

  const inputStyle: React.CSSProperties = {
    padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 14, color: '#374151',
  }

  return (
    <div className="section-card">
      <h2 style={{ fontSize: 16 }}>감사 로그</h2>
      <p style={{ color: '#64748b', fontSize: 14, marginTop: -6, marginBottom: 14 }}>
        대시보드에서 일어난 수동·자동 작업 이력. 계정 시스템이 없어 "언제·무엇을"만 기록된다.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <input
          placeholder="검색 (행위·상세)..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ ...inputStyle, flex: '0 1 260px' }}
        />
        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value as typeof categoryFilter)} style={inputStyle}>
          <option value="all">전체 카테고리</option>
          {(Object.keys(CATEGORY_LABEL) as Category[]).map(c => (
            <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
          ))}
        </select>
        <select value={modeFilter} onChange={e => setModeFilter(e.target.value as typeof modeFilter)} style={inputStyle}>
          <option value="all">수동+자동</option>
          <option value="manual">수동만</option>
          <option value="auto">자동만</option>
        </select>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={inputStyle} />
        <span style={{ alignSelf: 'center', color: '#94a3b8', fontSize: 14 }}>~</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={inputStyle} />
      </div>

      {error ? (
        <div style={{ fontSize: 14, color: '#ef4444' }}>
          불러오기 실패 — 서버가 재시작됐다면 관리자 모드를 다시 켜보세요.
        </div>
      ) : entries === null ? (
        <div style={{ fontSize: 14, color: '#94a3b8' }}>불러오는 중...</div>
      ) : filtered.length === 0 ? (
        <div style={{ fontSize: 14, color: '#94a3b8' }}>조건에 맞는 기록 없음 ({entries.length}건 중 0건)</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 13, color: '#94a3b8' }}>{filtered.length}건 (전체 {entries.length}건)</div>
          {filtered.map(e => (
            <div
              key={e.id}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                gap: 12, padding: '10px 14px', background: '#f8fafc', borderRadius: 8,
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <CategoryBadge action={e.action} />
                  <ModeBadge mode={e.mode} />
                  <span style={{ fontSize: 15, fontWeight: 600, color: '#1e293b' }}>
                    {ACTION_LABEL[e.action] ?? e.action}
                  </span>
                </div>
                {e.detail && (
                  <div style={{ fontSize: 13, color: '#94a3b8' }}>{e.detail}</div>
                )}
              </div>
              <span style={{ fontSize: 13, color: '#64748b', whiteSpace: 'nowrap' }}>{e.created_at}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
