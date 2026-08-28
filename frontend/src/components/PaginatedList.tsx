// 항목 배열을 페이지 단위로 잘라 보여주는 범용 페이지네이션 목록.
// HistoryList(감사 로그)와 ApiConsole의 한도 초과일 호출 이력처럼, "긴 목록을 한 번에 다
// 뿌리지 말고 페이지로 나눠서 보여줘야 하는" 화면에서 공통으로 쓴다. 실제 항목이 어떻게
// 생겼는지는 모르고 renderItem에 그대로 위임한다.
import { useState, type ReactNode } from 'react'

export default function PaginatedList<T>({
  items, pageSize = 5, getKey, renderItem,
}: {
  items: T[]
  pageSize?: number
  getKey: (item: T) => string | number
  renderItem: (item: T) => ReactNode
}) {
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const current = Math.min(page, totalPages)
  const paged = items.slice((current - 1) * pageSize, current * pageSize)

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {paged.map(item => <div key={getKey(item)}>{renderItem(item)}</div>)}
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
