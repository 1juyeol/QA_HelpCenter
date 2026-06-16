// 미지의 버그 탐지기 인사이트 페이지.
// call_memo의 한국어 명사 중 이번 주 갑자기 급증한 키워드 TOP 10을 표로 보여준다.
// 아직 CS 분류 체계에 잡히지 않은 새 문제(제품·기기·앱 결함 등)를 카테고리화 전에 포착하는 것이 목적.
// 증가율 = 이번주 빈도 / 직전 4주 주당 평균. is_new = 직전 4주 0회 등장(NEW 배지).
// "이번 주" 건수를 클릭하면 해당 키워드를 포함한 이번 주 call_memo 목록을 팝업으로 보여준다.
// 데이터 소스: /api/stats/keyword_trend(급증 키워드), /api/stats/keyword_memos(키워드 클릭 시 메모).
import { useEffect, useRef, useState } from 'react'
import { api, type KeywordTrendRow, type KeywordMemoRow } from '../../api/client'

// 증가율을 주황색 배경 강도로 변환한다. 높을수록 진한 주황.
function growthRateToBg(rate: number): string {
  if (rate <= 1)  return 'transparent'
  if (rate <= 3)  return '#fff7ed'
  if (rate <= 7)  return '#fed7aa'
  if (rate <= 15) return '#fb923c'
  return '#ea580c'
}

function growthRateToColor(rate: number): string {
  if (rate <= 7) return '#9a3412'
  return '#ffffff'
}

export default function UnknownBugDetector() {
  const [keywordTrend, setKeywordTrend] = useState<KeywordTrendRow[]>([])
  const [keywordLoading, setKeywordLoading] = useState(true)
  const [selectedKeyword, setSelectedKeyword] = useState<string | null>(null)
  const [keywordMemos, setKeywordMemos] = useState<KeywordMemoRow[]>([])
  const [memoLoading, setMemoLoading] = useState(false)
  const todayRef = useRef<string>('')

  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10)
    todayRef.current = today
    loadKeywords(today)
  }, [])

  async function loadKeywords(today: string) {
    setKeywordLoading(true)
    try {
      const data = await api.fetchKeywordTrend(today)
      setKeywordTrend(data)
    } finally {
      setKeywordLoading(false)
    }
  }

  async function openMemoModal(keyword: string) {
    setSelectedKeyword(keyword)
    setKeywordMemos([])
    setMemoLoading(true)
    try {
      const data = await api.fetchKeywordMemos(keyword, todayRef.current)
      setKeywordMemos(data)
    } finally {
      setMemoLoading(false)
    }
  }

  return (
    <div className="container">
      {/* 메모 팝업 모달 */}
      {selectedKeyword && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setSelectedKeyword(null)}
        >
          <div
            style={{ background: '#fff', borderRadius: 14, width: '90%', maxWidth: 600, maxHeight: '75vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>"{selectedKeyword}" 포함 메모 — 이번 주</span>
              <button onClick={() => setSelectedKeyword(null)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#94a3b8', lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ overflowY: 'auto', padding: '12px 20px', flex: 1 }}>
              {memoLoading ? (
                <div style={{ color: '#94a3b8', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>불러오는 중...</div>
              ) : !keywordMemos.length ? (
                <div style={{ color: '#94a3b8', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>메모 없음</div>
              ) : keywordMemos.map((m, i) => (
                <div key={i} style={{ borderBottom: '1px solid #f1f5f9', padding: '10px 0' }}>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>{m.date}</div>
                  <div style={{ fontSize: 13, color: '#1e293b', lineHeight: 1.6 }}>{m.memo}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="section-card">
        <h2>미지의 버그 탐지기 <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 400 }}>이번 주 기준</span></h2>
        <p style={{ fontSize: 13, color: '#94a3b8', marginBottom: 16 }}>
          CS 메모에서 이번 주 갑자기 급증한 키워드예요. 아직 분류 체계에 잡히지 않은 새 문제를 포착할 수 있어요.
        </p>
        {keywordLoading ? (
          <div className="loading">키워드 분석 중... (처음 로딩은 잠시 걸릴 수 있어요)</div>
        ) : !keywordTrend.length ? (
          <div className="empty">이번 주 급증 키워드 없음</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                  <th style={{ padding: '8px 10px', textAlign: 'left', color: '#94a3b8', fontWeight: 600, fontSize: 11 }}>#</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', color: '#94a3b8', fontWeight: 600, fontSize: 11 }}>키워드</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', color: '#94a3b8', fontWeight: 600, fontSize: 11 }}>이번 주</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', color: '#94a3b8', fontWeight: 600, fontSize: 11 }}>4주 평균</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', color: '#94a3b8', fontWeight: 600, fontSize: 11 }}>증가율</th>
                  <th style={{ padding: '8px 10px', textAlign: 'center', color: '#94a3b8', fontWeight: 600, fontSize: 11, width: 160 }}>
                    신규<br /><span style={{ fontWeight: 400, fontSize: 10 }}>(직전 4주 미등장)</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keywordTrend.map((row, i) => (
                  <tr key={row.word} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '9px 10px', color: '#94a3b8', fontSize: 12 }}>{i + 1}</td>
                    <td style={{ padding: '9px 10px', fontWeight: 600, color: '#1e293b' }}>{row.word}</td>
                    <td
                      style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 600, color: '#2563eb', cursor: 'pointer', textDecoration: 'underline' }}
                      onClick={() => openMemoModal(row.word)}
                    >{row.this_week}</td>
                    <td style={{ padding: '9px 10px', textAlign: 'right', color: '#64748b' }}>{row.avg_per_week.toFixed(1)}</td>
                    <td style={{
                      padding: '9px 10px', textAlign: 'right', fontWeight: 700,
                      background: growthRateToBg(row.growth_rate),
                      color: growthRateToColor(row.growth_rate),
                    }}>
                      {row.is_new ? '신규' : `${Math.round(row.growth_rate)}배`}
                    </td>
                    <td style={{ padding: '9px 10px', textAlign: 'center' }}>
                      {row.is_new && (
                        <span style={{
                          background: '#dbeafe', color: '#1d4ed8',
                          borderRadius: 999, padding: '2px 10px',
                          fontSize: 11, fontWeight: 700,
                        }}>NEW</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
