// 좌측 네비게이션 사이드바. 대시보드 링크와 인사이트 서브메뉴(접기·펼치기)를 표시한다.
// NavLink로 현재 경로를 감지해 활성 메뉴를 하이라이트한다.
// 메뉴 열림/닫힘(insightsOpen) 로컬 상태만 관리하며 다른 상태나 API 호출은 없다.
// 인사이트 목록: 보고서(준비 중) / 방치된 JIRA 버그 / 미지의 버그 탐지기 / 반복 Wings 티켓 / 학부모 반복 인입 / 서비스 품질 지수
import { useState } from 'react'
import { NavLink } from 'react-router-dom'

export default function Sidebar() {
  const [insightsOpen, setInsightsOpen] = useState(true)

  return (
    <nav className="sidebar">
      <NavLink
        to="/"
        end
        className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
      >
        <span className="nav-icon">📊</span> 대시보드
      </NavLink>

      <div
        className={`nav-group-label${insightsOpen ? ' open' : ''}`}
        onClick={() => setInsightsOpen(o => !o)}
      >
        <span className="nav-icon">💡</span> 인사이트
        <span className="nav-arrow">&#9658;</span>
      </div>

      <div className={`nav-sub${insightsOpen ? ' open' : ''}`}>
        <NavLink
          to="/report/daily"
          className={({ isActive }) => `nav-sub-item${isActive ? ' active' : ''}`}
        >
          일별 보고서
        </NavLink>
        <div className="nav-sub-item" style={{ color: '#cbd5e1', cursor: 'default' }}>
          주별 보고서
          <span style={{ fontSize: 10, marginLeft: 6, color: '#e2e8f0', background: '#94a3b8', borderRadius: 4, padding: '1px 5px' }}>준비 중</span>
        </div>
        <div className="nav-sub-item" style={{ color: '#cbd5e1', cursor: 'default' }}>
          월별 보고서
          <span style={{ fontSize: 10, marginLeft: 6, color: '#e2e8f0', background: '#94a3b8', borderRadius: 4, padding: '1px 5px' }}>준비 중</span>
        </div>
        <NavLink
          to="/insights/jira-bugs"
          className={({ isActive }) => `nav-sub-item${isActive ? ' active' : ''}`}
        >
          방치된 JIRA 버그
        </NavLink>

        <NavLink
          to="/insights/wings"
          className={({ isActive }) => `nav-sub-item${isActive ? ' active' : ''}`}
        >
          반복 Wings 티켓
        </NavLink>
        <NavLink
          to="/insights/parents"
          className={({ isActive }) => `nav-sub-item${isActive ? ' active' : ''}`}
        >
          학부모 반복 인입
        </NavLink>
        <NavLink
          to="/insights/sqi"
          className={({ isActive }) => `nav-sub-item${isActive ? ' active' : ''}`}
        >
          서비스 품질 지수
        </NavLink>
        <div className="nav-sub-item" style={{ color: '#cbd5e1', cursor: 'default' }}>
          이탈 신호
          <span style={{ fontSize: 10, marginLeft: 6, color: '#e2e8f0', background: '#94a3b8', borderRadius: 4, padding: '1px 5px' }}>준비 중</span>
          <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 2 }}>CS 없음 + 학습 감소 고객 리스트</div>
        </div>
        <div className="nav-sub-item" style={{ color: '#cbd5e1', cursor: 'default' }}>
          이탈 방어 근거
          <span style={{ fontSize: 10, marginLeft: 6, color: '#e2e8f0', background: '#94a3b8', borderRadius: 4, padding: '1px 5px' }}>준비 중</span>
          <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 2 }}>CS 전후 학습 변화 패턴</div>
        </div>
      </div>
    </nav>
  )
}
