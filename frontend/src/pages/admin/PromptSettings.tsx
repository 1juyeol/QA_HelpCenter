// Gemma 프롬프트 편집 화면. "자동화 관리" 페이지(AutomationManagement.tsx)의 "일간보고서
// 프롬프트"/"주간보고서 프롬프트" 탭이 이 파일의 PromptSettingsSection을 reportType만 바꿔
// 그대로 가져다 쓴다.
//
// 한 탭 안에 그 report_type이 실제로 Gemma를 호출하는 순서대로(daily: 카테고리→피크타임,
// weekly: 카테고리→종합) 프롬프트 편집 카드를 여러 개 나열한다(PromptEditor 하나당 카드 하나).
// 각 카드는 두 부분으로 나뉜다:
//   1. 데이터 필드 표 — 이 프롬프트에 실제로 전달되는 값과, 규칙이 그 값을 쓰라고 시키는지
//      여부를 그대로 보여준다(백엔드 prompt_registry.py가 코드와 대조해 정리해둔 값).
//   2. 규칙 텍스트 편집 — 실제로 Gemma에게 보내지는 시스템 프롬프트. 저장하면 다음 호출부터
//      바로 반영되고(서버 재시작 불필요), 기본값으로 되돌리기도 가능하다.
// 저장/초기화는 감사 로그(prompt_save/prompt_reset)에 남고, 이 화면에서 그 이력을 바로 보여준다.
import { useEffect, useState } from 'react'
import { api, type PromptCatalogItem, type AuditLogEntry } from '../../api/client'
import { useAdmin } from '../../hooks/useAdmin'
import HistoryList from '../../components/HistoryList'

function UsedBadge({ used }: { used: boolean | 'partial' }) {
  if (used === true) return <span style={{ color: '#15803d', fontWeight: 700 }}>✅ 사용</span>
  if (used === 'partial') return <span style={{ color: '#b45309', fontWeight: 700 }}>🟡 포괄적으로만</span>
  return <span style={{ color: '#dc2626', fontWeight: 700 }}>❌ 방치</span>
}

function PromptEditor({ item, allHistory }: { item: PromptCatalogItem; allHistory: AuditLogEntry[] | null }) {
  const { adminToken } = useAdmin()
  const [text, setText] = useState<string | null>(null)
  const [customized, setCustomized] = useState(item.customized)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!adminToken) return
    setText(null)
    setMessage('')
    api.fetchPromptSettings(item.key, adminToken).then(res => {
      setText(res.prompt_text)
      setCustomized(res.customized)
    }).catch(() => {})
  }, [adminToken, item.key])

  async function save() {
    if (text === null || !adminToken) return
    setSaving(true)
    setMessage('')
    try {
      const saved = await api.savePromptSettings(item.key, text, adminToken)
      setText(saved.prompt_text)
      setCustomized(saved.customized)
      setMessage('저장됐습니다. 다음 분석부터 바로 반영됩니다.')
    } catch {
      setMessage('저장 실패.')
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    if (!adminToken) return
    if (!window.confirm(`"${item.label}" 프롬프트를 기본값으로 되돌릴까요?`)) return
    setSaving(true)
    setMessage('')
    try {
      const reset = await api.resetPromptSettings(item.key, adminToken)
      setText(reset.prompt_text)
      setCustomized(reset.customized)
      setMessage('기본값으로 되돌렸습니다.')
    } catch {
      setMessage('초기화 실패.')
    } finally {
      setSaving(false)
    }
  }

  const history = allHistory?.filter(h => h.detail?.includes(`prompt_key=${item.key}`)) ?? null

  return (
    <div className="section-card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>{item.label}</h2>
        {customized && <span style={{ fontSize: 12, color: '#4338ca', fontWeight: 700 }}>커스텀 적용 중</span>}
      </div>
      <p style={{ fontSize: 14, color: '#64748b', margin: '0 0 16px' }}>{item.description}</p>

      {item.shared_notice && (
        <div style={{
          background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8,
          padding: '12px 14px', marginBottom: 16, fontSize: 14, color: '#78350f',
          lineHeight: 1.7, whiteSpace: 'pre-line',
        }}>
          {item.shared_notice}
        </div>
      )}

      <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', marginBottom: 8 }}>이 프롬프트에 전달되는 데이터</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20, fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #e2e8f0', color: '#64748b' }}>
            <th style={{ padding: '6px 8px' }}>데이터</th>
            <th style={{ padding: '6px 8px' }}>의미</th>
            <th style={{ padding: '6px 8px' }}>규칙이 쓰라고 하나?</th>
          </tr>
        </thead>
        <tbody>
          {item.fields.map(f => (
            <tr key={f.field} style={{ borderBottom: '1px solid #f1f5f9' }}>
              <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{f.field}</td>
              <td style={{ padding: '6px 8px', color: '#374151' }}>{f.desc}</td>
              <td style={{ padding: '6px 8px' }}>
                <UsedBadge used={f.used} />
                {f.note && <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{f.note}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', marginBottom: 8 }}>규칙 텍스트</div>
      {text === null ? (
        <div style={{ fontSize: 14, color: '#94a3b8' }}>불러오는 중...</div>
      ) : (
        <>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={16}
            style={{
              width: '100%', boxSizing: 'border-box', fontSize: 14, lineHeight: 1.6, color: '#334155',
              padding: 12, border: '1px solid #e2e8f0', borderRadius: 8, marginBottom: 12, resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
            <button
              onClick={save} disabled={saving}
              style={{ padding: '9px 18px', background: '#4338ca', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
            >
              {saving ? '저장 중...' : '저장'}
            </button>
            <button
              onClick={reset} disabled={saving || !customized}
              style={{ padding: '9px 18px', background: '#fff', color: '#64748b', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 14, fontWeight: 700, cursor: customized ? 'pointer' : 'default' }}
            >
              기본값으로 되돌리기
            </button>
            {message && <span style={{ fontSize: 14, color: '#64748b' }}>{message}</span>}
          </div>
        </>
      )}

      <div style={{ fontSize: 14, color: '#0f172a', fontWeight: 700, marginBottom: 10 }}>수정 이력</div>
      {history === null ? (
        <div style={{ fontSize: 14, color: '#94a3b8' }}>불러오는 중...</div>
      ) : history.length === 0 ? (
        <div style={{ fontSize: 14, color: '#94a3b8' }}>이력 없음</div>
      ) : (
        <HistoryList history={history} />
      )}
    </div>
  )
}

export function PromptSettingsSection({ reportType }: { reportType: 'daily' | 'weekly' }) {
  const { adminToken } = useAdmin()
  const [catalog, setCatalog] = useState<PromptCatalogItem[] | null>(null)
  const [history, setHistory] = useState<AuditLogEntry[] | null>(null)

  useEffect(() => {
    if (!adminToken) return
    setCatalog(null)
    setHistory(null)
    api.fetchPromptCatalog(reportType, adminToken).then(setCatalog).catch(() => setCatalog([]))
    api.fetchAuditLog(adminToken, 200)
      .then(entries => setHistory(entries.filter(e => e.action === 'prompt_save' || e.action === 'prompt_reset')))
      .catch(() => setHistory([]))
  }, [adminToken, reportType])

  if (!catalog) {
    return (
      <div className="section-card">
        <div style={{ fontSize: 14, color: '#94a3b8' }}>불러오는 중...</div>
      </div>
    )
  }

  return (
    <div>
      {catalog.map(item => (
        <PromptEditor key={item.key} item={item} allHistory={history} />
      ))}
    </div>
  )
}
