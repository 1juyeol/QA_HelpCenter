// 앱의 최상위 레이아웃 컴포넌트이자 라우터. 헤더(제목·날짜·마지막 수집 시각)와 사이드바를 렌더링하고
// URL 경로에 따라 Dashboard / WingsTickets / RepeatParents / JiraBugs / KeywordTrend / 보고서 페이지를 교체한다 (정책 7).
// 마지막 수집 시각 표시를 위해 /api/collection/latest를 60초 간격으로 폴링하는 것만 여기서 담당하며,
// 그 외 기능 로직은 모두 각 페이지 컴포넌트 안에 있다.
import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import StrategicDashboard from './pages/dashboard/StrategicDashboard'
import Dashboard from './pages/dashboard/Dashboard'
import ServiceQualityIndex from './pages/insights/ServiceQualityIndex'

import WingsTickets from './pages/insights/WingsTickets'
import RepeatParents from './pages/insights/RepeatParents'
import JiraBugs from './pages/insights/JiraBugs'
import KeywordTrend from './pages/insights/KeywordTrend'
import DailyReport from './pages/report/DailyReport'
import WeeklyReport from './pages/report/WeeklyReport'
import { api } from './api/client'

function headerDate() {
  const d = new Date()
  const days = ['일', '월', '화', '수', '목', '금', '토']
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]})`
}

export default function App() {
  const [lastCollected, setLastCollected] = useState('마지막 수집: —')

  useEffect(() => {
    const load = () => {
      api.fetchLatestCollection()
        .then(r => {
          if (r?.collected_at) {
            setLastCollected(`마지막 수집: ${r.collected_at.slice(0, 16).replace('T', ' ')}`)
          }
        })
        .catch(() => {})
    }
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [])

  return (
    <BrowserRouter>
      <header>
        <div className="header-left">
          <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
            <h1 style={{ cursor: 'pointer' }}>공감센터 CS 대시보드</h1>
          </Link>
          <p>{headerDate()}</p>
        </div>
        <span id="last-collected">{lastCollected}</span>
      </header>
      <div className="layout">
        <Sidebar />
        <div className="content">
          <Routes>
            <Route path="/" element={<StrategicDashboard />} />
            <Route path="/operations" element={<Dashboard />} />
            <Route path="/insights/sqi" element={<ServiceQualityIndex />} />

            <Route path="/insights/wings" element={<WingsTickets />} />
            <Route path="/insights/parents" element={<RepeatParents />} />
            <Route path="/insights/jira-bugs" element={<JiraBugs />} />
            <Route path="/insights/keywords" element={<KeywordTrend />} />
            <Route path="/report/daily" element={<DailyReport />} />
            <Route path="/report/weekly" element={<WeeklyReport />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  )
}
