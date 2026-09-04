// 설정 화면 공용 필드 한 줄(라벨 + 입력 요소 + 설명 힌트) 컴포넌트.
// 메일링 관리·자동화 관리처럼 "on/off, 시각, 값 하나씩 입력받는 설정 화면"에서 공통으로 쓴다.
import { ReactNode } from 'react'

export default function FieldRow({
  label, hint, children,
}: {
  label: string
  // 문장이 2개 이상이면 배열로 넘긴다 — 한 문단으로 이어 붙이면 좁은 폭에서 문장 중간이
  // 어색하게 줄바꿈되니, 문장 단위로 줄을 나눠 항상 문장 경계에서만 끊기게 한다.
  hint?: string | string[]
  children: ReactNode
}) {
  const hintLines = Array.isArray(hint) ? hint : hint ? [hint] : []
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 15, color: '#0f172a', fontWeight: 700, marginBottom: 8 }}>{label}</div>
      <div>{children}</div>
      {hintLines.length > 0 && (
        <div style={{ fontSize: 15, color: '#334155', marginTop: 6, maxWidth: 640, lineHeight: 1.7 }}>
          {hintLines.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}
    </div>
  )
}
