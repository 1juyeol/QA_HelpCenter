// 좌측 네비게이션 사이드바. 대시보드 링크와 인사이트 서브메뉴(접기·펼치기)를 표시한다.
// NavLink로 현재 경로를 감지해 활성 메뉴를 하이라이트한다.
// 인사이트 목록: 월별 보고서(준비 중) / 반복 Wings 티켓 / 학부모 반복 상담 / 방치된 JIRA 버그 / 미지의 버그 탐지기 / 서비스 품질 지수
// / 이탈·교체 원인 분석(하위: 해지 사유 분석, 기기 교체 분석, 해지 방어 성과)
// 관리자 모드: 하단 자물쇠 아이콘 클릭 → 암호 입력 모달 → useAdmin().verify()로 확인.
//   통과하면 다음이 추가로 노출된다:
//   - 인사이트 서브메뉴에 관리자 전용 페이지 4개(해야 할 일 / API 관리 / 감사 로그 / 메일링 관리)
//   - "리스크 비율 기준" 안내, "설정"(Gemma 서버 URL 변경 — GET/POST /api/settings/gemma) 섹션
//     → 둘 다 일반 사용자에게는 불필요한 내부 정보라 관리자 전용으로 숨겨뒀다.
//   - CS 상담 수집 API 호출 on/off 토글 버튼 (GET/POST /api/collection/status,enabled)
import { useState, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import { api } from '../api/client'
import { useAdmin } from '../hooks/useAdmin'

export default function Sidebar() {
  const [insightsOpen, setInsightsOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [presets, setPresets] = useState<string[]>([])
  const [currentUrl, setCurrentUrl] = useState('')
  const [selectedUrl, setSelectedUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const { isAdmin, adminToken, verify, logout } = useAdmin()
  const [adminModalOpen, setAdminModalOpen] = useState(false)
  const [passcodeInput, setPasscodeInput] = useState('')
  const [adminError, setAdminError] = useState(false)

  const [collectionEnabled, setCollectionEnabled] = useState<boolean | null>(null)
  const [collectionBusy, setCollectionBusy] = useState(false)

  async function handleAdminSubmit() {
    const ok = await verify(passcodeInput)
    if (ok) {
      setAdminModalOpen(false)
      setPasscodeInput('')
      setAdminError(false)
    } else {
      setAdminError(true)
    }
  }

  useEffect(() => {
    api.fetchCollectionStatus().then(s => setCollectionEnabled(s.enabled)).catch(() => {})
  }, [])

  async function handleToggleCollection() {
    if (!adminToken || collectionEnabled === null) return
    setCollectionBusy(true)
    try {
      const result = await api.setCollectionEnabled(!collectionEnabled, adminToken)
      setCollectionEnabled(result.enabled)
    } catch {
      alert('전환 실패 — 서버가 재시작됐다면 관리자 모드를 다시 켜주세요.')
      logout()
    } finally {
      setCollectionBusy(false)
    }
  }

  useEffect(() => {
    if (!isAdmin) return
    api.fetchGemmaSettings().then(s => {
      setPresets(s.presets)
      setCurrentUrl(s.url)
      setSelectedUrl(s.url)
    }).catch(() => {})
  }, [isAdmin])

  async function handleSave() {
    setSaving(true)
    try {
      await api.setGemmaUrl(selectedUrl)
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
        <div className="nav-sub-item" style={{ color: '#cbd5e1', cursor: 'default' }}>
          월별 보고서
          <span style={{ fontSize: 10, marginLeft: 6, color: '#e2e8f0', background: '#94a3b8', borderRadius: 4, padding: '1px 5px' }}>준비 중</span>
        </div>
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
          학부모 반복 상담
        </NavLink>
        <NavLink
          to="/insights/jira-bugs"
          className={({ isActive }) => `nav-sub-item${isActive ? ' active' : ''}`}
        >
          방치된 JIRA 버그
        </NavLink>
        <div className="nav-sub-item" style={{ color: '#94a3b8', fontWeight: 700, cursor: 'default' }}>
          이탈·교체 원인 분석
        </div>
        <NavLink
          to="/insights/churn-reasons"
          className={({ isActive }) => `nav-sub-item${isActive ? ' active' : ''}`}
          style={{ paddingLeft: 56 }}
        >
          해지 사유 분석
        </NavLink>
        <NavLink
          to="/insights/device-swaps"
          className={({ isActive }) => `nav-sub-item${isActive ? ' active' : ''}`}
          style={{ paddingLeft: 56 }}
        >
          기기 교체 분석
        </NavLink>
        <NavLink
          to="/insights/retention"
          className={({ isActive }) => `nav-sub-item${isActive ? ' active' : ''}`}
          style={{ paddingLeft: 56 }}
        >
          해지 방어 성과
        </NavLink>
        {isAdmin && (
          <NavLink
            to="/admin/insights"
            className={({ isActive }) => `nav-sub-item${isActive ? ' active' : ''}`}
          >
            🔒 해야 할 일
          </NavLink>
        )}
        {isAdmin && (
          <NavLink
            to="/admin/audit"
            className={({ isActive }) => `nav-sub-item${isActive ? ' active' : ''}`}
          >
            🔒 감사 로그
          </NavLink>
        )}
        {isAdmin && (
          <NavLink
            to="/admin/automation"
            className={({ isActive }) => `nav-sub-item${isActive ? ' active' : ''}`}
          >
            🔒 자동화 관리
          </NavLink>
        )}
      </div>

      {isAdmin && (
        <>
          {/* 리스크 비율 기준 (관리자 전용) */}
          <div style={{ borderTop: '1px solid #e2e8f0', marginTop: 8, padding: '10px 16px 14px' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#94a3b8', marginBottom: 8, letterSpacing: '0.4px' }}>
              🔒 리스크 비율 기준
            </div>
            <div style={{ fontSize: 16, color: '#64748b', marginBottom: 8 }}>
              위험 상담 ÷ 전체 상담 × 100
            </div>
            <div style={{ fontSize: 16, color: '#94a3b8', lineHeight: 1.9 }}>
              <div>• 네트워크·앱 오류 (전체)</div>
              <div>• 기기·하드웨어 오류 (전체)</div>
              <div>• 교재·물류 › 기기 장기미회수</div>
              <div>• 교재·물류 › 누락·오배송</div>
            </div>
          </div>

          {/* 설정 (관리자 전용) */}
          <div style={{ borderTop: '1px solid #e2e8f0', marginTop: 8 }}>
            <button
              onClick={() => setSettingsOpen(o => !o)}
              style={{
                width: '100%', padding: '10px 20px',
                background: 'transparent', border: 'none',
                color: settingsOpen ? '#1e293b' : '#64748b',
                fontSize: 20, fontWeight: 500, textAlign: 'left',
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
              }}
            >
              <span style={{ fontSize: 18, width: 20, textAlign: 'center' }}>⚙</span> 🔒 설정
            </button>
            {settingsOpen && (
              <div style={{ padding: '0 12px 12px' }}>
                <div style={{ fontSize: 16, color: '#94a3b8', marginBottom: 6, fontWeight: 600 }}>
                  Gemma 서버
                </div>
                <select
                  value={selectedUrl}
                  onChange={e => setSelectedUrl(e.target.value)}
                  style={{
                    width: '100%', padding: '6px 8px',
                    background: '#fff', border: '1px solid #e2e8f0',
                    borderRadius: 6, color: '#374151', fontSize: 16,
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
                    fontSize: 16, fontWeight: 600,
                    cursor: selectedUrl === currentUrl ? 'default' : 'pointer',
                  }}
                >
                  {saved ? '저장됨 ✓' : saving ? '저장 중...' : '저장'}
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* 관리자 모드 */}
      <div style={{ borderTop: '1px solid #e2e8f0', marginTop: 8 }}>
        <button
          onClick={() => (isAdmin ? logout() : setAdminModalOpen(true))}
          style={{
            width: '100%', padding: '10px 20px',
            background: 'transparent', border: 'none',
            color: isAdmin ? '#16a34a' : '#64748b',
            fontSize: 20, fontWeight: 500, textAlign: 'left',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
          }}
        >
          <span style={{ fontSize: 18, width: 20, textAlign: 'center' }}>{isAdmin ? '🔓' : '🔒'}</span>
          {isAdmin ? '관리자 모드 끄기' : '관리자 모드'}
        </button>

        {isAdmin && collectionEnabled !== null && (
          <div style={{ padding: '0 16px 12px' }}>
            <div style={{ fontSize: 16, color: '#94a3b8', marginBottom: 6, fontWeight: 600 }}>
              CS 상담 수집 API
            </div>
            <button
              onClick={handleToggleCollection}
              disabled={collectionBusy}
              style={{
                width: '100%', padding: '7px 0',
                background: collectionEnabled ? '#ef4444' : '#16a34a',
                color: '#fff', border: 'none', borderRadius: 6,
                fontSize: 16, fontWeight: 600,
                cursor: collectionBusy ? 'default' : 'pointer',
                opacity: collectionBusy ? 0.6 : 1,
              }}
            >
              {collectionBusy
                ? '전환 중...'
                : collectionEnabled ? '⏸ 호출 중단하기 (현재 실행 중)' : '▶ 호출 시작하기 (현재 중단됨)'}
            </button>
          </div>
        )}
      </div>

      {adminModalOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
          }}
          onClick={() => setAdminModalOpen(false)}
        >
          <div
            style={{ background: '#fff', borderRadius: 12, padding: 20, width: 300 }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontSize: 18, fontWeight: 700, color: '#1e293b', marginBottom: 10 }}>
              관리자 암호 입력
            </div>
            <input
              type="password"
              value={passcodeInput}
              autoFocus
              onChange={e => { setPasscodeInput(e.target.value); setAdminError(false) }}
              onKeyDown={e => e.key === 'Enter' && handleAdminSubmit()}
              style={{
                width: '100%', padding: '8px 10px', boxSizing: 'border-box',
                border: `1px solid ${adminError ? '#ef4444' : '#e2e8f0'}`,
                borderRadius: 6, fontSize: 16, marginBottom: 8,
              }}
            />
            {adminError && (
              <div style={{ fontSize: 15, color: '#ef4444', marginBottom: 8 }}>암호가 틀렸습니다.</div>
            )}
            <button
              onClick={handleAdminSubmit}
              style={{
                width: '100%', padding: '7px 0', background: '#3b82f6', color: '#fff',
                border: 'none', borderRadius: 6, fontSize: 16, fontWeight: 600, cursor: 'pointer',
              }}
            >
              확인
            </button>
          </div>
        </div>
      )}
    </nav>
  )
}
