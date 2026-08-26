// 공통 알림 팝업 컴포넌트.
// 브라우저 기본 alert()는 "localhost 내용:" 같은 시스템 팝업으로 떠서 눈에 잘 안 띄고
// 다른 화면 요소와 스타일도 안 맞는다 — 그 대신 서비스 UI에 맞는 모달로 안내 메시지를
// 확실하게 보여줄 때 이 컴포넌트를 쓴다.
//
// 사용법:
//   const [alertMsg, setAlertMsg] = useState<string | null>(null)
//   ...
//   {alertMsg && <AlertModal message={alertMsg} onClose={() => setAlertMsg(null)} />}
//
// props:
//   message : 보여줄 안내 문구
//   onClose : "확인" 버튼 또는 바깥 영역 클릭 시 호출되는 닫기 콜백
import { ReactNode } from 'react'

export default function AlertModal({ message, onClose }: { message: ReactNode; onClose: () => void }) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 420,
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)', textAlign: 'center',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ fontSize: 17, color: '#1e293b', lineHeight: 1.6, marginBottom: 20 }}>
          {message}
        </div>
        <button
          onClick={onClose}
          style={{
            background: '#1e3c72', color: '#fff', border: 'none', borderRadius: 8,
            padding: '10px 28px', fontSize: 16, fontWeight: 700, cursor: 'pointer',
          }}
        >
          확인
        </button>
      </div>
    </div>
  )
}
