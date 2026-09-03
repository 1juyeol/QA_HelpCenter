// Wings 티켓·학부모 반복 상담 캐시 자동 갱신 설정 화면. "자동화 관리" 페이지
// (AutomationManagement.tsx)의 "인사이트 자동 갱신" 탭이 이 파일이 내보내는
// InsightRefreshSettingsSection을 jobType만 바꿔 그대로 가져다 쓴다.
//
// GenerationSettings.tsx(일별/주간 보고서 생성 설정)와 같은 구조(on/off + 시각, 저장하면
// 그 즉시 스케줄 재등록, 이력은 감사 로그 필터링)지만 두 가지가 다르다:
//   - AI(Gemma) 분석이 없는 단순 집계+DB/Wings API 조회라 VPN 경고 배너가 필요 없다.
//   - "지금 갱신해보기" 링크는 보고서 페이지가 아니라 실제 새로고침 버튼이 있는 인사이트
//     페이지(반복 Wings 티켓/학부모 반복 상담)로 보낸다.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type GenerationSettings, type AuditLogEntry } from '../../api/client'
import { useAdmin } from '../../hooks/useAdmin'
import FieldRow from '../../components/FieldRow'
import HistoryList from '../../components/HistoryList'
import TimePicker from '../../components/TimePicker'

type InsightJobType = 'wings_refresh' | 'repeat_parents_refresh'

const INSIGHT_LABEL: Record<InsightJobType, string> = {
  wings_refresh: '반복 Wings 티켓',
  repeat_parents_refresh: '학부모 반복 상담',
}

const INSIGHT_LINK: Record<InsightJobType, string> = {
  wings_refresh: '/insights/wings',
  repeat_parents_refresh: '/insights/parents',
}

// 이 jobType의 갱신이 남기는 감사 로그 action 전부(성공/스킵).
const HISTORY_ACTIONS: Record<InsightJobType, string[]> = {
  wings_refresh: ['wings_cache_refresh', 'wings_cache_refresh_skipped'],
  repeat_parents_refresh: ['repeat_parents_cache_refresh', 'repeat_parents_cache_refresh_skipped'],
}

export function InsightRefreshSettingsSection({ jobType }: { jobType: InsightJobType }) {
  const { adminToken } = useAdmin()
  const [settings, setSettings] = useState<GenerationSettings | null>(null)
  const [history, setHistory] = useState<AuditLogEntry[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  function loadHistory(token: string) {
    const actions = new Set(HISTORY_ACTIONS[jobType])
    api.fetchAuditLog(token, 200)
      .then(entries => setHistory(entries.filter(e => actions.has(e.action))))
      .catch(() => setHistory([]))
  }

  useEffect(() => {
    if (!adminToken) return
    setSettings(null)
    setHistory(null)
    api.fetchGenerationSettings(jobType, adminToken).then(setSettings).catch(() => {})
    loadHistory(adminToken)
  }, [adminToken, jobType])

  async function save() {
    if (!settings || !adminToken) return
    setSaving(true)
    setMessage('')
    try {
      const saved = await api.saveGenerationSettings(settings, adminToken)
      setSettings(saved)
      setMessage('저장됐습니다.')
    } catch (err) {
      const detail = err instanceof Error ? (() => { try { return JSON.parse(err.message).detail } catch { return null } })() : null
      setMessage(detail ?? '저장 실패.')
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    if (!adminToken) return
    if (!window.confirm(`${INSIGHT_LABEL[jobType]} 자동 갱신 설정을 기본값으로 되돌릴까요?`)) return
    setSaving(true)
    setMessage('')
    try {
      const reset = await api.resetGenerationSettings(jobType, adminToken)
      setSettings(reset)
      setMessage('기본값으로 초기화했습니다.')
    } catch {
      setMessage('초기화 실패.')
    } finally {
      setSaving(false)
    }
  }

  if (!settings) {
    return (
      <div className="section-card">
        <div style={{ fontSize: 14, color: '#94a3b8' }}>불러오는 중...</div>
      </div>
    )
  }

  function updateTime(h: number, m: number) {
    setSettings(s => s && { ...s, generate_hour: h, generate_minute: m })
  }

  return (
    <div className="section-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>{INSIGHT_LABEL[jobType]} 자동 갱신 설정</h2>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#0f172a', fontWeight: 700, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={e => setSettings({ ...settings, enabled: e.target.checked })}
          />
          자동 갱신 켜짐 (끄면 설정은 유지되고 갱신만 안 함)
        </label>
      </div>

      <FieldRow label="갱신 시각" hint="매일 이 시각에 캐시를 다시 계산합니다.">
        <TimePicker hour={settings.generate_hour} minute={settings.generate_minute} onChange={updateTime} />
      </FieldRow>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
        <button
          onClick={save} disabled={saving}
          style={{ padding: '9px 18px', background: '#4338ca', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
        >
          {saving ? '저장 중...' : '저장'}
        </button>
        <button
          onClick={reset} disabled={saving}
          style={{ padding: '9px 18px', background: '#fff', color: '#64748b', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
        >
          기본값으로 초기화
        </button>
        {message && <span style={{ fontSize: 14, color: '#64748b' }}>{message}</span>}
      </div>

      <FieldRow label="지금 갱신해보기">
        <Link to={INSIGHT_LINK[jobType]} style={{ fontSize: 15, color: '#4338ca', fontWeight: 700 }}>
          {INSIGHT_LABEL[jobType]} 페이지에서 새로고침 →
        </Link>
      </FieldRow>

      <div style={{ fontSize: 15, color: '#0f172a', fontWeight: 700, marginTop: 20, marginBottom: 10 }}>갱신 이력</div>
      {history === null ? (
        <div style={{ fontSize: 14, color: '#94a3b8' }}>불러오는 중...</div>
      ) : history.length === 0 ? (
        <div style={{ fontSize: 14, color: '#94a3b8' }}>이력 없음</div>
      ) : (
        <HistoryList history={history} />
      )}
    </div>
  )
}
