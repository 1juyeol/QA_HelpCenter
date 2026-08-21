// 알약(pill) 모양의 작은 라벨 뱃지. 관리자 페이지들(감사 로그·API 관리)에서 카테고리·상태·
// 수동/자동 구분 등을 표시할 때 공용으로 쓴다. 색만 다르고 모양은 똑같은 뱃지가 페이지마다
// 따로 정의돼 있던 걸 하나로 모았다.
import type { ReactNode, CSSProperties } from 'react'

interface BadgeProps {
  children: ReactNode
  color?: string
  textColor?: string
}

export default function Badge({ children, color = '#94a3b8', textColor = '#fff' }: BadgeProps) {
  const style: CSSProperties = {
    fontSize: 12, fontWeight: 700, color: textColor, background: color,
    borderRadius: 4, padding: '2px 7px', whiteSpace: 'nowrap', display: 'inline-block',
  }
  return <span style={style}>{children}</span>
}
