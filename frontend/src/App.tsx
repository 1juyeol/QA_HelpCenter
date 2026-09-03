// 앱의 최상위 레이아웃 컴포넌트이자 라우터. 헤더(제목·날짜·마지막 수집 시각)와 사이드바를 렌더링하고
// URL 경로에 따라 Dashboard / WingsTickets / RepeatParents / JiraBugs / 보고서 /
// 관리자 페이지(인사이트 로드맵·감사 로그·자동화 관리)를 교체한다 (정책 7).
// 마지막 수집 시각 표시를 위해 /api/collection/latest를 60초 간격으로 폴링하는 것만 여기서 담당하며,
// 그 외 기능 로직은 모두 각 페이지 컴포넌트 안에 있다.
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import StrategicDashboard from './pages/dashboard/StrategicDashboard'
import Dashboard from './pages/dashboard/Dashboard'
import ServiceQualityIndex from './pages/insights/ServiceQualityIndex'

import WingsTickets from './pages/insights/WingsTickets'
import RepeatParents from './pages/insights/RepeatParents'
import JiraBugs from './pages/insights/JiraBugs'
import ChurnReasonInsight from './pages/insights/ChurnReasonInsight'
import DeviceSwapInsight from './pages/insights/DeviceSwapInsight'
import RetentionInsight from './pages/insights/RetentionInsight'
import DailyReport from './pages/report/DailyReport'
import WeeklyReport from './pages/report/WeeklyReport'
import InsightRoadmap from './pages/admin/InsightRoadmap'
import AuditLog from './pages/admin/AuditLog'
import AutomationManagement from './pages/admin/AutomationManagement'

function headerDate() {
  const d = new Date()
  const days = ['일', '월', '화', '수', '목', '금', '토']
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]})`
}

export default function App() {

  return (
    <BrowserRouter>
      <header>
        <div className="header-left">
          <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
            <h1 style={{ cursor: 'pointer' }}>공감센터 CS 대시보드</h1>
          </Link>
          <p>{headerDate()}</p>
        </div>
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
            <Route path="/insights/churn-reasons" element={<ChurnReasonInsight />} />
            <Route path="/insights/device-swaps" element={<DeviceSwapInsight />} />
            <Route path="/insights/retention" element={<RetentionInsight />} />
            <Route path="/report/daily" element={<DailyReport />} />
            <Route path="/report/weekly" element={<WeeklyReport />} />
            <Route path="/admin/insights" element={<InsightRoadmap />} />
            <Route path="/admin/audit" element={<AuditLog />} />
            <Route path="/admin/automation" element={<AutomationManagement />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  )
}
