// 관리자 설정 화면 상단에 붙이는 공용 경고 배너. 사내망 전용 서버를 쓰는 기능(메일 발송,
// 보고서 자동 생성 등)에서 "재택 등 사외에서는 VPN이 필요하다"는 걸 눈에 띄게 안내할 때 쓴다.
import { ReactNode } from 'react'

export default function WarningBanner({ children }: { children: ReactNode }) {
  return (
    <div style={{
      background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8,
      padding: '12px 16px', fontSize: 15, color: '#92400e', marginBottom: 20, lineHeight: 1.7,
    }}>
      {children}
    </div>
  )
}
