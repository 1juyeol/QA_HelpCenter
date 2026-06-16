// JIRA 미해결 버그 × CS 연관 분석 인사이트 페이지.
// DQ-424 에픽 하위 이슈 중 [학생앱]·[학부모앱]·[PC홈페이지] 태그가 있고 종료·완료 아닌 이슈를 표시한다.
// 각 이슈별로 CS 메모 키워드 매칭으로 집계된 연관 CS 건수를 보여주며, 건수 내림차순으로 정렬된다.
// 행 클릭 시 해당 이슈에 연관된 CS 메모 전체를 펼쳐 보여준다 (지연 로딩).
// 데이터: GET /api/jira/bugs (캐시 60분), GET /api/jira/bugs/{key}/memos, POST /api/jira/sync.
import { Fragment, useEffect, useState } from 'react'
import { api, type JiraBug, type JiraBugMemo } from '../../api/client'

const STATUS_COLOR: Record<string, string> = {
  '미해결':       '#ef4444',
  '검토 중':      '#f59e0b',
  '진행 중':      '#3b82f6',
  'Staging Done': '#8b5cf6',
  'QA확인':       '#10b981',
  'PENDING':      '#94a3b8',
}

function statusBadge(status: string) {
  const color = STATUS_COLOR[status] ?? '#94a3b8'
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 12,
      fontSize: 11, fontWeight: 600, color: '#fff', background: color,
      whiteSpace: 'nowrap',
    }}>
      {status}
    </span>
  )
}

export default function JiraBugs() {
  const [bugs, setBugs] = useState<JiraBug[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncedAt, setSyncedAt] = useState<string | null>(null)

  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [memos, setMemos] = useState<JiraBugMemo[]>([])
  const [memosLoading, setMemosLoading] = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const res = await api.fetchJiraBugs()
      setBugs(res.data || [])
      const ts = res.data?.[0]?.synced_at
      setSyncedAt(ts ? ts.slice(0, 16) : null)
    } finally {
      setLoading(false)
    }
  }

  async function handleSync() {
    setSyncing(true)
    try {
      await api.syncJiraBugs()
      await load()
    } finally {
      setSyncing(false)
    }
  }

  async function toggleRow(key: string) {
    if (expandedKey === key) {
      setExpandedKey(null)
      setMemos([])
      return
    }
    setExpandedKey(key)
    setMemos([])
    setMemosLoading(true)
    try {
      const res = await api.fetchJiraBugMemos(key)
      setMemos(res.data || [])
    } finally {
      setMemosLoading(false)
    }
  }

  const jiraUrl = (key: string) => `https://danbiedu-dev.atlassian.net/browse/${key}`

  return (
    <div className="container">
      <div className="section-card">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>🔧 방치된 JIRA 버그</h2>
            <p style={{ fontSize: 13, color: '#94a3b8', margin: 0 }}>
              JIRA에 미해결 상태로 남아 있는 서비스 버그 중, CS 메모에서 같은 증상이 언급된 건수를 집계합니다.
              CS 건수가 많을수록 실제 고객 영향이 큰 방치된 이슈입니다.
            </p>
            <p style={{ fontSize: 12, color: '#cbd5e1', margin: '8px 0 0', lineHeight: 1.6 }}>
              분석 흐름: JIRA 이슈 요약 → 키워드 추출 → CS 메모 LIKE 검색 (AND 조건)<br />
              현재는 규칙 기반 추출 (정확도 제한적) · 예정: Ollama(gemma4:12b)가 이슈를 읽고
              CS 신고 가능 여부 판단 후 키워드 직접 생성
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, marginLeft: 24 }}>
            {syncedAt && (
              <span style={{ fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap' }}>
                동기화: {syncedAt}
              </span>
            )}
            <button
              onClick={handleSync}
              disabled={syncing || loading}
              style={{
                padding: '8px 16px', background: '#fff', border: '1px solid #e2e8f0',
                borderRadius: 8, cursor: syncing ? 'default' : 'pointer',
                fontSize: 13, fontWeight: 500, color: '#374151', whiteSpace: 'nowrap',
              }}
            >
              {syncing ? '동기화 중...' : '↻ 새로고침'}
            </button>
          </div>
        </div>

        <div className="insight-table-wrap">
          {loading ? (
            <div className="loading">불러오는 중...</div>
          ) : !bugs.length ? (
            <div className="empty">JIRA 이슈 없음 (자격증명을 확인하세요)</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th style={{ width: 100 }}>이슈</th>
                  <th>요약</th>
                  <th style={{ width: 110 }}>상태</th>
                  <th style={{ width: 100 }}>생성일</th>
                  <th style={{ width: 90 }}>CS 건수</th>
                </tr>
              </thead>
              <tbody>
                {bugs.map((bug, i) => {
                  const isOpen = expandedKey === bug.key
                  return (
                    <Fragment key={bug.key}>
                      <tr
                        onClick={() => toggleRow(bug.key)}
                        style={{ cursor: 'pointer', background: isOpen ? '#f8fafc' : undefined }}
                      >
                        <td>
                          <span className={`rank-badge${i < 3 ? ' top' : ''}`}>{i + 1}</span>
                        </td>
                        <td>
                          <a
                            href={jiraUrl(bug.key)}
                            target="_blank"
                            rel="noreferrer"
                            onClick={e => e.stopPropagation()}
                            style={{ color: '#1a56db', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}
                          >
                            {bug.key}
                          </a>
                        </td>
                        <td style={{ fontSize: 13, color: '#374151' }}>
                          {bug.summary}
                          {bug.cs_keywords && (
                            <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {bug.cs_keywords.split(',').filter(Boolean).map(kw => (
                                <span key={kw} style={{
                                  fontSize: 11, padding: '1px 6px', background: '#f1f5f9',
                                  borderRadius: 4, color: '#64748b', border: '1px solid #e2e8f0',
                                }}>{kw}</span>
                              ))}
                            </div>
                          )}
                          <button className="memo-toggle" style={{ marginTop: 4 }}>
                            {isOpen ? '▼ 접기' : `▶ CS 메모 보기`}
                          </button>
                        </td>
                        <td>{statusBadge(bug.status)}</td>
                        <td style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>
                          {bug.created_at}
                        </td>
                        <td>
                          {bug.cs_count > 0
                            ? <span className="count-badge">{bug.cs_count}건</span>
                            : <span style={{ fontSize: 12, color: '#cbd5e1' }}>—</span>}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={6} style={{ padding: 0 }}>
                            <div className="memo-expand-inner">
                              {memosLoading ? (
                                <div style={{ padding: 16, color: '#94a3b8', fontSize: 13 }}>불러오는 중...</div>
                              ) : !memos.length ? (
                                <div style={{ padding: 16, color: '#94a3b8', fontSize: 13 }}>매칭된 CS 메모 없음</div>
                              ) : (
                                memos.map((m, mi) => (
                                  <div key={mi} className="memo-item">
                                    <div className="memo-item-date">
                                      {m.created_date ? m.created_date.slice(0, 16) : '—'}
                                      {m.category_main && ` · ${m.category_main}`}
                                      {m.category_sub && ` > ${m.category_sub}`}
                                    </div>
                                    <div>
                                      {m.call_memo
                                        ? m.call_memo.split('\n').map((line, li) => (
                                            <span key={li}>{li > 0 && <br />}{line}</span>
                                          ))
                                        : ''}
                                    </div>
                                  </div>
                                ))
                              )}
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
      </div>
    </div>
  )
}
