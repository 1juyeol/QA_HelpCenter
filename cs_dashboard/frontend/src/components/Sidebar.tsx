// 좌측 네비게이션 사이드바. 대시보드 링크와 인사이트 서브메뉴(접기·펼치기)를 표시한다.
// NavLink로 현재 경로를 감지해 활성 메뉴를 하이라이트한다.
// 하단 설정 아이콘: Ollama 서버 URL을 드롭다운으로 변경하고 저장할 수 있다.
//   - GET /api/settings/ollama : 현재 URL + 프리셋 목록
//   - POST /api/settings/ollama : URL 변경 (메모리 즉시 반영 + 파일 저장)
// 인사이트 목록: 보고서(준비 중) / 방치된 JIRA 버그 / 미지의 버그 탐지기 / 반복 Wings 티켓 / 학부모 반복 인입 / 서비스 품질 지수
import { useState, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import { api } from '../api/client'

export default function Sidebar() {
  const [insightsOpen, setInsightsOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [presets, setPresets] = useState<string[]>([])
  const [currentUrl, setCurrentUrl] = useState('')
  const [selectedUrl, setSelectedUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.fetchOllamaSettings().then(s => {
      setPresets(s.presets)
      setCurrentUrl(s.url)
      setSelectedUrl(s.url)
    }).catch(() => {})
  }, [])

  async function handleSave() {
    setSaving(true)
    try {
      await api.setOllamaUrl(selectedUrl)
      setCurrentUrl(selectedUrl)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      alert('저장 실패')
    } finally {
      setSaving(false)
    }
  }

  return (
    <nav className="sidebar" style={{ display: 'flex', flexDirection: 'column' }}>
      <NavLink
        to="/"
        end
        className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
      >
        <span className="nav-icon">📊</span> 대시보드
      </NavLink>
      <NavLink
        to="/operations"
        className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
      >
        <span className="nav-icon">🖥️</span> 운영 현황
      </NavLink>

      <div
        className={`nav-group-label${insightsOpen ? ' open' : ''}`}
        onClick={() => setInsightsOpen(o => !o)}
      >
        <span className="nav-icon">💡</span> 인사이트
        <span className="nav-arrow" />
      </div>

      <div className={`nav-sub${insightsOpen ? ' open' : ''}`}>
        <NavLink
          to="/report/daily"
          className={({ isActive }) => `nav-sub-item${isActive ? ' active' : ''}`}
        >
          일별 보고서
        </NavLink>
        <NavLink
          to="/report/weekly"
          className={({ isActive }) => `nav-sub-item${isActive ? ' active' : ''}`}
        >
          주간 보고서
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
          to="/insights/keywords"
          className={({ isActive }) => `nav-sub-item${isActive ? ' active' : ''}`}
        >
          이슈 후보 탐지
        </NavLink>
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

      {/* 설정 */}
      <div style={{ borderTop: '1px solid #e2e8f0', marginTop: 8 }}>
        <button
          onClick={() => setSettingsOpen(o => !o)}
          style={{
            width: '100%', padding: '10px 20px',
            background: 'transparent', border: 'none',
            color: settingsOpen ? '#1e293b' : '#64748b',
            fontSize: 14, fontWeight: 500, textAlign: 'left',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
          }}
        >
          <span style={{ fontSize: 16, width: 20, textAlign: 'center' }}>⚙</span> 설정
        </button>
        {settingsOpen && (
          <div style={{ padding: '0 12px 12px' }}>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6, fontWeight: 600 }}>
              Ollama 서버
            </div>
            <select
              value={selectedUrl}
              onChange={e => setSelectedUrl(e.target.value)}
              style={{
                width: '100%', padding: '6px 8px',
                background: '#fff', border: '1px solid #e2e8f0',
                borderRadius: 6, color: '#374151', fontSize: 12,
                marginBottom: 8,
              }}
            >
              {presets.map(p => (
                <option key={p} value={p}>{p.replace('http://', '')}</option>
              ))}
            </select>
            <button
              onClick={handleSave}
              disabled={saving || selectedUrl === currentUrl}
              style={{
                width: '100%', padding: '6px 0',
                background: saved ? '#16a34a' : selectedUrl === currentUrl ? '#f1f5f9' : '#3b82f6',
                color: selectedUrl === currentUrl ? '#94a3b8' : '#fff',
                border: 'none', borderRadius: 6,
                fontSize: 12, fontWeight: 600,
                cursor: selectedUrl === currentUrl ? 'default' : 'pointer',
              }}
            >
              {saved ? '저장됨 ✓' : saving ? '저장 중...' : '저장'}
            </button>
          </div>
        )}
      </div>

      {/* 리스크율 기준 */}
      <div style={{ borderTop: '1px solid #e2e8f0', marginTop: 8, padding: '10px 16px 14px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', marginBottom: 8, letterSpacing: '0.4px' }}>
          리스크율 기준
        </div>
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>
          위험 상담 ÷ 전체 상담 × 100
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.9 }}>
          <div>• 네트워크·앱 오류 (전체)</div>
          <div>• 기기·하드웨어 오류 (전체)</div>
          <div>• 교재·물류 › 기기 장기미회수</div>
          <div>• 교재·물류 › 누락·오배송</div>
        </div>
      </div>
    </nav>
  )
}
