// React 앱 진입점. index.html의 #root에 App을 마운트하고 전역 CSS를 로드한다.
// AdminProvider로 감싸서 관리자 로그인 상태를 앱 전체가 공유하게 한다 (hooks/useAdmin.tsx 참고).
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AdminProvider } from './hooks/useAdmin'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AdminProvider>
      <App />
    </AdminProvider>
  </React.StrictMode>
)
