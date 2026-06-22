// 키워드 급등 탐지 페이지. CS 메모(call_memo)에서 kiwipiepy로 추출한 한국어 명사 중
// 이번 주 처음 등장하거나 직전 4주 평균 대비 급증한 키워드를 표시한다.
// 분류 체계에 잡히지 않은 미지의 이슈를 조기 탐지하는 것이 목적이다.
//
// 데이터 흐름:
//   GET /api/stats/keyword_trend?target_date=YYYY-MM-DD
//     → kiwipiepy 형태소 분석 → 이번 주 vs 직전 4주 평균 비교 → TOP 10 반환 (당일 캐시)
//   GET /api/stats/keyword_memos?keyword=...&target_date=YYYY-MM-DD
//     → 키워드 클릭 시 해당 메모 목록 조회
//
// KeywordTrendRow: { word, this_week, avg_per_week, growth_rate, is_new }
//   is_new=true  : 직전 4주에 한 번도 등장하지 않은 단어 → 신규 등장 섹션
//   is_new=false : 이미 등장했지만 growth_rate 높은 단어 → 급증 중 섹션
import { useEffect, useState } from 'react'
import { api, type KeywordTrendRow, type KeywordMemoRow } from '../../api/client'

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function KeywordCard({ row, selected, onClick, variant }: {
  row: KeywordTrendRow
  selected: boolean
  onClick: () => void
  variant: 'new' | 'growth'
}) {
  const isNew = variant === 'new'
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
        {isNew && (
          <span style={{ fontSize: 10, fontWeight: 700, background: '#1d4ed8', color: '#fff', borderRadius: 999, padding: '2px 6px' }}>NEW</span>
        )}
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: isNew ? '#1d4ed8' : '#b45309' }}>
          이번 주 {row.this_week}건
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
          {isNew ? '직전 4주 0회' : `평균 대비 ${row.growth_rate.toFixed(1)}배`}
        </div>
      </div>
    </button>
  )
}

export default function KeywordTrend() {
  const [targetDate, setTargetDate] = useState(todayStr())
  const [rows, setRows] = useState<KeywordTrendRow[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedWord, setSelectedWord] = useState<string | null>(null)
  const [memos, setMemos] = useState<KeywordMemoRow[]>([])
  const [memosLoading, setMemosLoading] = useState(false)

  useEffect(() => { load() }, [targetDate])

  async function load() {
    setLoading(true)
    setSelectedWord(null)
    setMemos([])
    try {
      const data = await api.fetchKeywordTrend(targetDate)
      setRows(data)
    } finally {
      setLoading(false)
    }
  }

  async function handleSelectWord(word: string) {
    if (selectedWord === word) {
      setSelectedWord(null)
      setMemos([])
      return
    }
    setSelectedWord(word)
    setMemosLoading(true)
    setMemos([])
    try {
      const data = await api.fetchKeywordMemos(word, targetDate)
      setMemos(data)
    } finally {
      setMemosLoading(false)
    }
  }

  const newRows = rows.filter(r => r.is_new)
  const growthRows = rows.filter(r => !r.is_new)

  return (
    <div className="container">
      <div className="section-card">
        <h2>키워드 급등 탐지</h2>
        <p style={{ fontSize: 13, color: '#94a3b8', marginBottom: 16 }}>
          CS 메모에서 이번 주 처음 등장하거나 급증한 단어 — 분류 체계에 잡히지 않은 미지의 이슈 조기 탐지용입니다.
        </p>

        <div className="insight-toolbar">
          <input
            type="date"
            value={targetDate}
            max={todayStr()}
            onChange={e => { setTargetDate(e.target.value) }}
            style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, color: '#374151' }}
          />
          <button
            onClick={load}
            disabled={loading}
            style={{ padding: '8px 16px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, cursor: loading ? 'default' : 'pointer', fontSize: 13, fontWeight: 500, color: '#374151' }}
          >
            {loading ? '분석 중...' : '↻ 새로고침'}
          </button>
        </div>

        {loading ? (
          <div className="loading">분석 중... (첫 조회는 수 초 소요될 수 있습니다)</div>
        ) : !rows.length ? (
          <div className="empty">이번 주 급증 키워드 없음</div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#1e40af', marginBottom: 10, letterSpacing: '0.4px' }}>
                  신규 등장
                  {newRows.length > 0 && <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 6 }}>({newRows.length}개)</span>}
                </div>
                {newRows.length === 0 ? (
                  <div style={{ fontSize: 13, color: '#94a3b8' }}>없음</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {newRows.map(r => (
                      <KeywordCard key={r.word} row={r} selected={selectedWord === r.word} onClick={() => handleSelectWord(r.word)} variant="new" />
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#b45309', marginBottom: 10, letterSpacing: '0.4px' }}>
                  급증 중
                  {growthRows.length > 0 && <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 6 }}>({growthRows.length}개)</span>}
                </div>
                {growthRows.length === 0 ? (
                  <div style={{ fontSize: 13, color: '#94a3b8' }}>없음</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {growthRows.map(r => (
                      <KeywordCard key={r.word} row={r} selected={selectedWord === r.word} onClick={() => handleSelectWord(r.word)} variant="growth" />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {selectedWord && (
              <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 12 }}>
                  "{selectedWord}" 포함 메모
                </div>
                {memosLoading ? (
                  <div className="loading">불러오는 중...</div>
                ) : !memos.length ? (
                  <div className="empty">메모 없음</div>
                ) : (
                  <div className="memo-expand-inner" style={{ maxHeight: 360, overflowY: 'auto' }}>
                    {memos.map((m, i) => (
                      <div key={i} className="memo-item">
                        <div className="memo-item-date">{m.date ? m.date.slice(0, 16) : '—'}</div>
                        <div>
                          {m.memo
                            ? m.memo.split('\n').map((line, li) => <span key={li}>{li > 0 && <br />}{line}</span>)
                            : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
