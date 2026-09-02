// 이슈 후보 탐지 페이지 (구 키워드 급등 탐지). CS 메모에서 탐지된 키워드의 탐지 이력과 지속성을 확인한다.
// 키워드만으로 실제 서비스 장애·결함을 확정할 수 없으며, 사람이 원문을 검토하기 위한 보조 인사이트 화면이다.
//
// 3개 탭 구조:
//   오늘 탐지  : fetchKeywordTrend(date) — 선택일 기준 신규·급증 키워드
//   지속 언급  : fetchKeywordHistory()   — 최근 7일 내 2일 이상 탐지된 키워드 (지속 언급·재급증)
//   탐지 이력  : fetchKeywordHistory()   — 전체 키워드 이력 테이블
//
// 키워드 클릭 시 상세 패널:
//   fetchKeywordTrendDates(word) → 날짜별 탐지 흐름
//   fetchKeywordMemos(word, date) → 날짜 클릭 시 해당 주 메모 (지연 로딩)
//
// 자동 상태: 지속 탐지 / 재탐지 / 신규 탐지 / 일회성 탐지 / 감소 추세 / 최근 미탐지 (백엔드 계산)
import { Fragment, useEffect, useRef, useState } from 'react'
import {
  api,
  type KeywordTrendRow,
  type KeywordHistoryRow,
  type KeywordTrendDateRow,
  type KeywordMemoRow,
} from '../../api/client'

type Tab = 'today' | 'persistent' | 'history'

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  '지속 탐지':  { bg: '#fef3c7', color: '#92400e' },
  '재탐지':     { bg: '#ffedd5', color: '#9a3412' },
  '신규 탐지':  { bg: '#eff6ff', color: '#1e40af' },
  '일회성 탐지':{ bg: '#f1f5f9', color: '#64748b' },
  '감소 추세':  { bg: '#fafaf9', color: '#78716c' },
  '최근 미탐지':{ bg: '#f8fafc', color: '#94a3b8' },
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function getMondayOfWeek(dateStr: string) {
  const d = new Date(dateStr)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d.toISOString().slice(0, 10)
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? { bg: '#f1f5f9', color: '#64748b' }
  return (
    <span style={{
      display: 'inline-block', background: s.bg, color: s.color,
      borderRadius: 999, padding: '2px 8px', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {status}
    </span>
  )
}

const STATUS_GUIDE = [
  { status: '지속 탐지',   desc: '최근 7일 내 탐지 조건을 2일 이상 충족. 반복 탐지된 표현이나 실제 장애가 지속된다는 의미는 아닙니다.' },
  { status: '재탐지',      desc: '7일 이상 탐지되지 않다가 다시 탐지 조건을 충족한 키워드입니다.' },
  { status: '신규 탐지',   desc: '최근 기준 기간 내 처음으로 탐지 조건을 충족한 키워드입니다.' },
  { status: '최근 미탐지', desc: '최근 7일 탐지 기준을 충족하지 않은 키워드. 해결·종결을 의미하지 않습니다.' },
  { status: '일회성 탐지', desc: '전체 탐지 이력에서 탐지된 날짜가 1일뿐인 키워드입니다.' },
  { status: '감소 추세',   desc: '여러 날짜에 걸쳐 언급 건수가 실제로 연속 감소한 경우에만 표시됩니다.' },
]

function StatusGuide() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: 18, height: 18, borderRadius: '50%',
          background: open ? '#3b82f6' : '#e2e8f0',
          color: open ? '#fff' : '#64748b',
          border: 'none', cursor: 'pointer',
          fontSize: 11, fontWeight: 700, lineHeight: '18px', padding: 0,
          flexShrink: 0,
        }}
        title="자동 상태 설명"
      >?</button>
      {open && (
        <div style={{
          position: 'absolute', top: 24, left: 0, zIndex: 100,
          background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
          boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
          padding: '12px 16px', minWidth: 320,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', marginBottom: 10, letterSpacing: '0.3px' }}>자동 상태 기준</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {STATUS_GUIDE.map(g => (
              <div key={g.status} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <StatusBadge status={g.status} />
                <span style={{ fontSize: 12, color: '#374151', lineHeight: 1.5, paddingTop: 1 }}>{g.desc}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function MiniBar({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 4
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 60, height: 8, background: '#e2e8f0', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: '#3b82f6', borderRadius: 4 }} />
      </div>
      <span style={{ fontSize: 12, color: '#374151', fontWeight: 600 }}>
        {label && <span style={{ fontWeight: 400, color: '#94a3b8', marginRight: 2 }}>{label} </span>}{value}건
      </span>
    </div>
  )
}

// ── 키워드 상세 패널 ────────────────────────────────────────────────────────────

function KeywordDetailPanel({
  word,
  historyRow,
  onClose,
}: {
  word: string
  historyRow: KeywordHistoryRow | null
  onClose: () => void
}) {
  const [dateRows, setDateRows] = useState<KeywordTrendDateRow[]>([])
  const [dateLoading, setDateLoading] = useState(true)
  const [expandedDate, setExpandedDate] = useState<string | null>(null)
  const [memoMap, setMemoMap] = useState<Record<string, KeywordMemoRow[]>>({})
  const [memoLoadingDate, setMemoLoadingDate] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDateLoading(true)
    setDateRows([])
    setExpandedDate(null)
    setMemoMap({})
    api.fetchKeywordTrendDates(word).then(setDateRows).finally(() => setDateLoading(false))
  }, [word])

  useEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [word])

  async function handleDateClick(date: string) {
    if (expandedDate === date) { setExpandedDate(null); return }
    setExpandedDate(date)
    if (memoMap[date]) return
    setMemoLoadingDate(date)
    try {
      const memos = await api.fetchKeywordMemos(word, date)
      setMemoMap(prev => ({ ...prev, [date]: memos }))
    } finally {
      setMemoLoadingDate(null)
    }
  }

  // 같은 주의 여러 항목은 마지막(최신) 날짜만 남긴다 — 주간 누적이라 중간 날짜는 중복 정보
  const weeklyRows = Object.values(
    dateRows.reduce((acc, r) => {
      const monday = getMondayOfWeek(r.date)
      if (!acc[monday] || r.date > acc[monday].date) acc[monday] = r
      return acc
    }, {} as Record<string, typeof dateRows[0]>)
  ).sort((a, b) => b.date.localeCompare(a.date))

  const maxCount = Math.max(...weeklyRows.map(r => r.this_week), 1)

  return (
    <div ref={panelRef} style={{ borderTop: '2px solid #e2e8f0', paddingTop: 20, marginTop: 8 }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: '#111827' }}>{word}</span>
            {historyRow && <StatusBadge status={historyRow.auto_status} />}
          </div>
          {historyRow && (
            <div style={{ fontSize: 12, color: '#64748b', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <span>최초 탐지: {historyRow.first_detected}</span>
              <span>최근 탐지: {historyRow.last_detected}</span>
              <span>최고치: {historyRow.peak_date} · {historyRow.peak_count}건 · {historyRow.peak_growth}배</span>
              <span>탐지 {historyRow.detection_days}일 · 최근 7일 {historyRow.recent_detection_days}일</span>
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#94a3b8', padding: 4 }}
        >✕</button>
      </div>

      {/* 주차별 탐지 흐름 */}
      <div style={{ marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>주차별 탐지 흐름</span>
        <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 8 }}>건수는 해당 날짜 기준 그 주 월요일부터의 누적입니다</span>
      </div>
      {dateLoading ? (
        <div className="loading">조회 중...</div>
      ) : !dateRows.length ? (
        <div className="empty">탐지 이력 없음</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {weeklyRows.map(r => (
            <div key={r.date}>
              <button
                onClick={() => handleDateClick(r.date)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  width: '100%', padding: '8px 12px',
                  background: expandedDate === r.date ? '#f8fafc' : '#fff',
                  border: `1px solid ${expandedDate === r.date ? '#cbd5e1' : '#e2e8f0'}`,
                  borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                }}
              >
                <span style={{ fontSize: 12, color: '#64748b', flexShrink: 0 }}>
                  {getMondayOfWeek(r.date)} ~ {r.date}
                </span>
                <MiniBar value={r.this_week} max={maxCount} label="주간 누적" />
                <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 4 }}>
                  직전 4주 평균 대비 {r.growth_rate}배
                  {r.is_new && <span style={{ marginLeft: 6, background: '#1d4ed8', color: '#fff', borderRadius: 999, padding: '1px 5px', fontSize: 10, fontWeight: 700 }}>NEW</span>}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8' }}>
                  {expandedDate === r.date ? '▲ 메모 접기' : '▼ 탐지 근거 메모'}
                </span>
              </button>
              {expandedDate === r.date && (
                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderTop: 'none', borderRadius: '0 0 8px 8px', padding: '8px 12px' }}>
                  {memoLoadingDate === r.date ? (
                    <div style={{ fontSize: 13, color: '#94a3b8', padding: '8px 0' }}>조회 중...</div>
                  ) : !memoMap[r.date]?.length ? (
                    <div style={{ fontSize: 13, color: '#94a3b8', padding: '8px 0' }}>메모 없음</div>
                  ) : (
                    <div className="memo-expand-inner" style={{ maxHeight: 240, overflowY: 'auto', margin: 0, padding: 0, border: 'none', background: 'transparent' }}>
                      {memoMap[r.date].slice(0, 5).map((m, i) => (
                        <div key={i} className="memo-item">
                          <div className="memo-item-date">{m.date ?? '—'}</div>
                          <div>{m.memo?.split('\n').map((line, li) => <span key={li}>{li > 0 && <br />}{line}</span>)}</div>
                        </div>
                      ))}
                      {memoMap[r.date].length > 5 && (
                        <div style={{ fontSize: 12, color: '#94a3b8', padding: '4px 0' }}>외 {memoMap[r.date].length - 5}건</div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 10 }}>
        * 탐지 근거 메모는 해당 날짜가 속한 주의 CS 메모 중 이 키워드가 포함된 원문입니다. 키워드 급증만으로 장애·결함을 단정하지 마세요.
      </div>
    </div>
  )
}

// ── 메인 컴포넌트 ───────────────────────────────────────────────────────────────

export default function KeywordTrend() {
  const [activeTab, setActiveTab] = useState<Tab>('today')

  // 오늘 탐지 탭 — 항상 오늘 기준으로 고정
  const targetDate = todayStr()
  const [todayRows, setTodayRows] = useState<KeywordTrendRow[]>([])
  const [todayLoading, setTodayLoading] = useState(true)

  // 지속 언급 / 탐지 이력 탭
  const [historyRows, setHistoryRows] = useState<KeywordHistoryRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)

  // 공통 상세 패널
  const [selectedWord, setSelectedWord] = useState<string | null>(null)
  const [selectedHistoryRow, setSelectedHistoryRow] = useState<KeywordHistoryRow | null>(null)

  useEffect(() => { loadToday() }, [targetDate])

  async function loadToday() {
    setTodayLoading(true)
    setSelectedWord(null)
    try {
      const data = await api.fetchKeywordTrend(targetDate)
      setTodayRows(data)
    } finally {
      setTodayLoading(false)
    }
  }

  async function loadHistory() {
    if (historyLoaded) return
    setHistoryLoading(true)
    try {
      const data = await api.fetchKeywordHistory()
      setHistoryRows(data)
      setHistoryLoaded(true)
    } finally {
      setHistoryLoading(false)
    }
  }

  function handleTabChange(tab: Tab) {
    setActiveTab(tab)
    setSelectedWord(null)
    if (tab !== 'today' && !historyLoaded) loadHistory()
  }

  function handleSelectWord(word: string, historyRow: KeywordHistoryRow | null = null) {
    if (selectedWord === word) { setSelectedWord(null); return }
    setSelectedWord(word)
    setSelectedHistoryRow(historyRow)
  }

  const persistentRows = historyRows.filter(r => r.auto_status === '지속 탐지' || r.auto_status === '재탐지')
  const newRows = todayRows.filter(r => r.is_new)
  const growthRows = todayRows.filter(r => !r.is_new)

  return (
    <div className="container">
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, marginBottom: 4, fontSize: 24, fontWeight: 700, color: '#1e293b' }}>이슈 후보 탐지</h2>
        <p style={{ margin: 0, fontSize: 18, color: '#94a3b8' }}>
          CS 메모에서 탐지된 키워드의 지속성과 변화를 확인합니다. 키워드만으로 실제 장애·결함을 확정할 수 없으며, 원문 확인 후 판단이 필요합니다.
        </p>
      </div>
      <div className="section-card">

        {/* 탭 */}
        <div className="tabs" style={{ marginBottom: 20, display: 'inline-flex' }}>
          {([
            { id: 'today', label: '오늘 탐지' },
            { id: 'persistent', label: '지속 탐지' },
            { id: 'history', label: '탐지 이력' },
          ] as { id: Tab; label: string }[]).map(t => (
            <button
              key={t.id}
              className={activeTab === t.id ? 'active' : ''}
              onClick={() => handleTabChange(t.id)}
            >
              {t.label}
              {t.id === 'persistent' && historyLoaded && persistentRows.length > 0 && (
                <span style={{ marginLeft: 6, background: '#f59e0b', color: '#fff', borderRadius: 999, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>
                  {persistentRows.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── 오늘 탐지 탭 ── */}
        {activeTab === 'today' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                집계 기간: <span style={{ color: '#64748b', fontWeight: 600 }}>{getMondayOfWeek(targetDate)} (월) ~ {targetDate}</span> · 직전 4주 평균 대비 2배 이상 급증
              </div>
              <button
                onClick={loadToday}
                disabled={todayLoading}
                style={{ padding: '6px 14px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, cursor: todayLoading ? 'default' : 'pointer', fontSize: 13, fontWeight: 500, color: '#374151' }}
              >
                {todayLoading ? '분석 중...' : '↻ 새로고침'}
              </button>
            </div>

            {todayLoading ? (
              <div className="loading">분석 중... (첫 조회는 수 초 소요될 수 있습니다)</div>
            ) : !todayRows.length ? (
              <div className="empty">해당 날짜 급증 키워드 없음</div>
            ) : (
              <>
                {/* 요약 배너 */}
                <div style={{ display: 'flex', gap: 16, marginBottom: 16, fontSize: 13, color: '#64748b' }}>
                  <span>
                    <span style={{ fontWeight: 700, color: '#1e40af' }}>{newRows.length}</span>건 신규 탐지
                  </span>
                  <span style={{ color: '#cbd5e1' }}>·</span>
                  <span>
                    <span style={{ fontWeight: 700, color: '#b45309' }}>{growthRows.length}</span>건 급증 탐지
                  </span>
                </div>

                {/* 신규 탐지 — 있을 때만 별도 그룹 */}
                {newRows.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#1e40af', marginBottom: 8 }}>신규 탐지</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {newRows.map(r => (
                        <Fragment key={r.word}>
                          <TodayKeywordCard row={r} selected={selectedWord === r.word} onClick={() => handleSelectWord(r.word)} />
                          {selectedWord === r.word && <KeywordDetailPanel word={r.word} historyRow={selectedHistoryRow} onClose={() => setSelectedWord(null)} />}
                        </Fragment>
                      ))}
                    </div>
                  </div>
                )}

                {/* 급증 탐지 — 전체 폭 */}
                {growthRows.length > 0 && (
                  <div>
                    {newRows.length > 0 && (
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#b45309', marginBottom: 8 }}>급증 탐지</div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {growthRows.map(r => (
                        <Fragment key={r.word}>
                          <TodayKeywordCard row={r} selected={selectedWord === r.word} onClick={() => handleSelectWord(r.word)} />
                          {selectedWord === r.word && <KeywordDetailPanel word={r.word} historyRow={selectedHistoryRow} onClose={() => setSelectedWord(null)} />}
                        </Fragment>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* ── 지속 탐지 탭 ── */}
        {activeTab === 'persistent' && (
          <>
            <p style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
              최근 7일 내 탐지 조건을 2일 이상 충족한 키워드입니다. 반복 탐지된 표현으로, 원문 메모 확인이 필요할 수 있습니다. (지속 탐지는 실제 장애가 지속된다는 의미가 아니라, 탐지 조건이 여러 날 충족되었음을 뜻합니다.)
            </p>
            {historyLoading ? (
              <div className="loading">조회 중...</div>
            ) : !persistentRows.length ? (
              <div className="empty">최근 7일 내 지속 탐지된 키워드 없음</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {persistentRows.map(r => (
                  <Fragment key={r.word}>
                    <HistoryKeywordCard row={r} selected={selectedWord === r.word} onClick={() => handleSelectWord(r.word, r)} />
                    {selectedWord === r.word && <KeywordDetailPanel word={r.word} historyRow={r} onClose={() => setSelectedWord(null)} />}
                  </Fragment>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── 탐지 이력 탭 ── */}
        {activeTab === 'history' && (
          <>
            {historyLoading ? (
              <div className="loading">조회 중...</div>
            ) : !historyRows.length ? (
              <div className="empty">탐지 이력 없음 (스케줄러 실행 후 이력이 쌓입니다)</div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <p style={{ fontSize: 11, color: '#94a3b8', margin: 0 }}>
                    정렬: 지속 탐지 → 재탐지 → 신규 탐지 → 최근 미탐지 → 일회성 탐지 순. 클릭 시 상세 패널이 열립니다.
                  </p>
                  <StatusGuide />
                </div>
                <div className="insight-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ fontSize: 16 }}>키워드</th>
                      <th style={{ width: 110, fontSize: 16 }}>자동 상태</th>
                      <th style={{ width: 90, fontSize: 16 }}>최초 탐지</th>
                      <th style={{ width: 90, fontSize: 16 }}>최근 탐지</th>
                      <th style={{ width: 100, fontSize: 16 }}>최고치 일자</th>
                      <th style={{ width: 80, fontSize: 16 }}>최고 건수</th>
                      <th style={{ width: 80, fontSize: 16 }}>최고 배수</th>
                      <th style={{ width: 80, fontSize: 16 }}>탐지 일수</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyRows.map(r => (
                      <Fragment key={r.word}>
                        <tr
                          onClick={() => handleSelectWord(r.word, r)}
                          style={{ cursor: 'pointer', background: selectedWord === r.word ? '#f8fafc' : undefined }}
                        >
                          <td style={{ fontWeight: 600, color: '#111827', fontSize: 15 }}>{r.word}</td>
                          <td><StatusBadge status={r.auto_status} /></td>
                          <td style={{ fontSize: 15, color: '#64748b' }}>{r.first_detected}</td>
                          <td style={{ fontSize: 15, color: '#64748b' }}>{r.last_detected}</td>
                          <td style={{ fontSize: 15, color: '#64748b' }}>{r.peak_date}</td>
                          <td style={{ fontSize: 15, fontWeight: 600 }}>{r.peak_count}건</td>
                          <td style={{ fontSize: 15, color: '#b45309', fontWeight: 600 }}>{r.peak_growth}배</td>
                          <td style={{ fontSize: 15 }}>{r.detection_days}일</td>
                        </tr>
                        {selectedWord === r.word && (
                          <tr>
                            <td colSpan={8} style={{ padding: 0, border: 'none' }}>
                              <KeywordDetailPanel word={r.word} historyRow={r} onClose={() => setSelectedWord(null)} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </>
        )}

      </div>
    </div>
  )
}

// ── 서브 컴포넌트 ───────────────────────────────────────────────────────────────

function TodayKeywordCard({ row, selected, onClick }: { row: KeywordTrendRow; selected: boolean; onClick: () => void }) {
  const isNew = row.is_new
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px',
        background: selected ? (isNew ? '#eff6ff' : '#fffbeb') : '#fff',
        border: `1px solid ${selected ? (isNew ? '#93c5fd' : '#fcd34d') : '#e2e8f0'}`,
        borderRadius: 10, cursor: 'pointer', textAlign: 'left', width: '100%',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>{row.word}</span>
        {isNew && <span style={{ fontSize: 10, fontWeight: 700, background: '#1d4ed8', color: '#fff', borderRadius: 999, padding: '2px 6px' }}>NEW</span>}
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: isNew ? '#1d4ed8' : '#b45309' }}>주간 {row.this_week}건</div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
          {isNew ? '직전 4주 미탐지' : `직전 4주 평균 대비 ${row.growth_rate}배`}
        </div>
      </div>
    </button>
  )
}

function HistoryKeywordCard({ row, selected, onClick }: { row: KeywordHistoryRow; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px',
        background: selected ? '#f8fafc' : '#fff',
        border: `1px solid ${selected ? '#cbd5e1' : '#e2e8f0'}`,
        borderRadius: 10, cursor: 'pointer', textAlign: 'left', width: '100%',
      }}
    >
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>{row.word}</span>
          <StatusBadge status={row.auto_status} />
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8' }}>
          최초 탐지: {row.first_detected} · 최근 탐지: {row.last_detected} · 탐지 {row.detection_days}일
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>최고 {row.peak_count}건</div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>최고 배수 {row.peak_growth}배</div>
      </div>
    </button>
  )
}
