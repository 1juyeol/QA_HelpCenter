// 감사 로그 항목을 5개씩 페이지네이션해서 보여주는 공용 이력 목록.
// 메일링 발송 이력, 보고서 생성 이력처럼 "감사 로그를 특정 action으로 걸러서 보여주는"
// 화면에서 공통으로 쓴다 — 실제 표시는 전부 AuditLogRow(AuditLog.tsx)에 위임하고,
// 페이지 자르기 자체는 범용 PaginatedList에 위임한다.
import type { AuditLogEntry } from '../api/client'
import { AuditLogRow } from '../pages/admin/AuditLog'
import PaginatedList from './PaginatedList'

export default function HistoryList({ history }: { history: AuditLogEntry[] }) {
  return (
    <PaginatedList
      items={history}
      pageSize={5}
      getKey={e => e.id}
      renderItem={e => <AuditLogRow entry={e} />}
    />
  )
}
