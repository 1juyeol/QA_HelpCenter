// 감사 로그 항목을 5개씩 페이지네이션해서 보여주는 공용 이력 목록.
// 메일링 발송 이력, 보고서 생성 이력처럼 "감사 로그를 특정 action으로 걸러서 보여주는"
// 화면에서 공통으로 쓴다 — 실제 표시는 전부 AuditLogRow(AuditLog.tsx)에 위임한다.
import { useState } from 'react'
import type { AuditLogEntry } from '../api/client'
import { AuditLogRow } from '../pages/admin/AuditLog'

const HISTORY_PAGE_SIZE = 5

export default function HistoryList({ history }: { history: AuditLogEntry[] }) {
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE))
  const current = Math.min(page, totalPages)
  const paged = history.slice((current - 1) * HISTORY_PAGE_SIZE, current * HISTORY_PAGE_SIZE)

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {paged.map(e => <AuditLogRow key={e.id} entry={e} />)}
      </div>
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 12 }}>
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))} disabled={current === 1}
            style={{ padding: '6px 12px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', fontSize: 13, cursor: current === 1 ? 'default' : 'pointer', color: current === 1 ? '#cbd5e1' : '#475569' }}
          >
            이전
          </button>
          <span style={{ fontSize: 13, color: '#64748b' }}>{current} / {totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={current === totalPages}
            style={{ padding: '6px 12px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', fontSize: 13, cursor: current === totalPages ? 'default' : 'pointer', color: current === totalPages ? '#cbd5e1' : '#475569' }}
          >
            다음
          </button>
        </div>
      )}
    </div>
  )
}
