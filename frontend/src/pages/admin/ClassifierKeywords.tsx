// 분류 키워드 관리 화면. "자동화 관리" 페이지의 "분류 키워드 관리" 탭이 사용한다.
//
// classifier.py의 RULES(소분류별 키워드 목록)를 그대로 보여준다. 키워드 하나를 지우면
// ① 서버 메모리의 RULES에서 그 즉시 제거되고 ② 전체 CS 이슈가 바로 재분류된다(정책 4:
// 분류 규칙 변경 시 전체 재적용) — 재분류 결과(몇 건 바뀌었는지)를 그 자리에서 보여준다.
// 다른 소분류와 겹치는 키워드는 주황색으로 표시한다 — RULES는 위에서부터 먼저 매칭되는
// 규칙이 이기므로, 겹치는 키워드 중 뒤에 있는 소분류 쪽은 사실상 죽은 코드다.
import { useEffect, useState } from 'react'
import { api, type ClassifierRule } from '../../api/client'
import { useAdmin } from '../../hooks/useAdmin'

function KeywordChip({ sub, keyword, duplicateOf, onDelete }: {
  sub: string
  keyword: string
  duplicateOf: string[] | null
  onDelete: () => void
}) {
  return (
    <span
      title={duplicateOf ? `다른 소분류와도 겹침: ${duplicateOf.join(', ')}` : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 8px', borderRadius: 999, fontSize: 13,
        background: duplicateOf ? '#fff7ed' : '#f8fafc',
        border: `1px solid ${duplicateOf ? '#fdba74' : '#e2e8f0'}`,
        color: duplicateOf ? '#9a3412' : '#334155',
      }}
    >
      {keyword}
      <button
        onClick={onDelete}
        title={`"${keyword}" 삭제 (${sub})`}
        style={{
          border: 'none', background: 'transparent', color: '#94a3b8', cursor: 'pointer',
          fontSize: 13, lineHeight: 1, padding: 0,
        }}
      >
        ×
      </button>
    </span>
  )
}

function RuleGroup({ rule, onDelete }: { rule: ClassifierRule; onDelete: (sub: string, keyword: string) => void }) {
  const dupeCount = rule.keywords.filter(k => k.duplicate_of).length

  return (
    <div className="section-card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>{rule.sub}</h2>
        <span style={{ fontSize: 13, color: '#94a3b8' }}>{rule.keywords.length}개</span>
        {dupeCount > 0 && (
          <span style={{ fontSize: 12, color: '#c2410c', fontWeight: 700 }}>겹치는 키워드 {dupeCount}개</span>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {rule.keywords.map(k => (
          <KeywordChip
            key={k.keyword}
            sub={rule.sub}
            keyword={k.keyword}
            duplicateOf={k.duplicate_of}
            onDelete={() => onDelete(rule.sub, k.keyword)}
          />
        ))}
        {rule.keywords.length === 0 && <span style={{ fontSize: 13, color: '#94a3b8' }}>키워드 없음</span>}
      </div>
    </div>
  )
}

export function ClassifierKeywordsSection() {
  const { adminToken } = useAdmin()
  const [rules, setRules] = useState<ClassifierRule[] | null>(null)
  const [message, setMessage] = useState('')

  function load() {
    if (!adminToken) return
    api.fetchClassifierRules(adminToken).then(setRules).catch(() => setRules([]))
  }

  useEffect(load, [adminToken])

  async function handleDelete(sub: string, keyword: string) {
    if (!adminToken) return
    if (!window.confirm(`"${keyword}" 키워드를 "${sub}"에서 삭제할까요?\n삭제 즉시 전체 CS 데이터가 재분류됩니다.`)) return
    setMessage('삭제하고 재분류하는 중...')
    try {
      const res = await api.deleteClassifierKeyword(sub, keyword, adminToken)
      const r = res.reclassify_result
      setMessage(`삭제 완료. 전체 ${r.total.toLocaleString()}건 중 ${r.changed.toLocaleString()}건 재분류됐습니다.`)
      load()
    } catch {
      setMessage('삭제 실패.')
    }
  }

  if (!rules) {
    return (
      <div className="section-card">
        <div style={{ fontSize: 14, color: '#94a3b8' }}>불러오는 중...</div>
      </div>
    )
  }

  return (
    <div>
      {message && (
        <div style={{
          background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8,
          padding: '10px 14px', marginBottom: 14, fontSize: 14, color: '#1e40af',
        }}>
          {message}
        </div>
      )}
      {rules.map(rule => (
        <RuleGroup key={rule.sub} rule={rule} onDelete={handleDelete} />
      ))}
    </div>
  )
}
