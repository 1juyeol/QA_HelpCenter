// React 앱 진입점. index.html의 #root에 App을 마운트하고 전역 CSS를 로드한다.
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
