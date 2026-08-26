// 설정 화면 공용 필드 한 줄(라벨 + 입력 요소 + 설명 힌트) 컴포넌트.
// 메일링 관리·자동화 관리처럼 "on/off, 시각, 값 하나씩 입력받는 설정 화면"에서 공통으로 쓴다.
import { ReactNode } from 'react'

export default function FieldRow({
  label, hint, children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 15, color: '#0f172a', fontWeight: 700, marginBottom: 8 }}>{label}</div>
      <div>{children}</div>
      {hint && <div style={{ fontSize: 15, color: '#334155', marginTop: 6, maxWidth: 640, lineHeight: 1.7 }}>{hint}</div>}
    </div>
  )
}
