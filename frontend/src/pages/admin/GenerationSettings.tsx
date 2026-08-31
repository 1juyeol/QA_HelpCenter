// 일별/주간 보고서 자동 생성 설정 화면. "자동화 관리" 페이지(AutomationManagement.tsx)의
// "일별 보고서 생성"/"주간 보고서 생성" 탭이 이 파일이 내보내는 GenerationSettingsSection을
// report_type만 바꿔 그대로 가져다 쓴다.
//
// 메일링 설정(MailingSettings.tsx)과 같은 구조지만 더 단순하다 — 생성은 "무언가를 기다리는"
// 마감 시각 개념이 없고(그 자체가 파이프라인의 첫 단계라서) 발신자·수신자도 없어서 on/off +
// 생성 시각 하나뿐이다. 저장하면(POST /api/generation-settings) 백엔드가 그 즉시 스케줄을
// 새 시각으로 재등록한다 — 서버 재시작 없이 다음 생성부터 바뀐 설정이 반영된다.
//
// 지금 생성(테스트)은 이 화면에서 새로 만들지 않는다 — 보고서 페이지의 "재생성" 버튼이 이미
// 그 역할이라(POST /api/report/daily(weekly)/generate), 그 페이지로 가는 링크만 둔다.
//
// 생성 이력은 별도 API·별도 표시 형식 없이 기존 감사 로그(GET /api/audit/log)를 daily_report_*/
// weekly_report_* 액션으로 필터링해서 HistoryList(AuditLogRow)를 그대로 가져다 쓴다 — 요약
// 로그(성공/스킵/실패)뿐 아니라 카테고리별 세부 분석 로그도 함께 보여준다.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type GenerationSettings, type AuditLogEntry } from '../../api/client'
import { useAdmin } from '../../hooks/useAdmin'
import FieldRow from '../../components/FieldRow'
import WarningBanner from '../../components/WarningBanner'
import HistoryList from '../../components/HistoryList'
import TimePicker from '../../components/TimePicker'

type DailyOrWeekly = 'daily' | 'weekly'

const REPORT_LABEL: Record<DailyOrWeekly, string> = {
  daily: '일별 보고서',
  weekly: '주간 보고서',
}

// 이 report_type의 생성 파이프라인이 남기는 감사 로그 action 전부. 요약(성공/스킵/실패)뿐
// 아니라 카테고리별 세부 분석 로그까지 이력에 그대로 보여준다.
const HISTORY_ACTIONS: Record<DailyOrWeekly, string[]> = {
  daily: [
    'daily_report_generate_complete', 'daily_report_auto_generate_skipped', 'daily_report_auto_generate_failed',
    'daily_report_analyze_category', 'daily_report_analyze_peak', 'daily_report_analyze_anomaly', 'daily_report_retry_failed',
  ],
  weekly: [
    'weekly_report_auto_generate', 'weekly_report_auto_generate_skipped', 'weekly_report_auto_generate_failed',
    'weekly_report_analyze_category', 'weekly_report_analyze_summary',
  ],
}

export function GenerationSettingsSection({ reportType }: { reportType: DailyOrWeekly }) {
  const { adminToken } = useAdmin()
  const [settings, setSettings] = useState<GenerationSettings | null>(null)
  const [history, setHistory] = useState<AuditLogEntry[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  function loadHistory(token: string) {
    const actions = new Set(HISTORY_ACTIONS[reportType])
    api.fetchAuditLog(token, 200)
      .then(entries => setHistory(entries.filter(e => actions.has(e.action))))
      .catch(() => setHistory([]))
  }

  useEffect(() => {
    if (!adminToken) return
    setSettings(null)
    setHistory(null)
    api.fetchGenerationSettings(reportType, adminToken).then(setSettings).catch(() => {})
    loadHistory(adminToken)
  }, [adminToken, reportType])

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
    if (!window.confirm(`${REPORT_LABEL[reportType]} 자동 생성 설정을 기본값으로 되돌릴까요?`)) return
    setSaving(true)
    setMessage('')
    try {
      const reset = await api.resetGenerationSettings(reportType, adminToken)
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
      <WarningBanner>
        ⚠️ 보고서 생성 중 <strong>AI 분석 단계</strong>는 <strong>사내망 전용 AI 서버(Gemma)</strong>를 사용합니다. <strong>VPN이 연결되어 있지 않으면 AI 분석만 실패합니다.</strong> 재택 등 사외에서는 먼저 VPN을 켜주세요.
      </WarningBanner>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>{REPORT_LABEL[reportType]} 자동 생성 설정</h2>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#0f172a', fontWeight: 700, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={e => setSettings({ ...settings, enabled: e.target.checked })}
          />
          자동 생성 켜짐 (끄면 설정은 유지되고 생성만 안 함)
        </label>
      </div>

      <FieldRow
        label="생성 시각"
        hint={reportType === 'daily'
          ? '매일 이 시각에 직전 영업일 데이터를 기준으로 보고서를 생성합니다.'
          : '매주 월요일 이 시각에 직전 주(월~일) 데이터를 기준으로 보고서를 생성합니다.'}
      >
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

      <FieldRow label="지금 생성해보기">
        <Link to={`/report/${reportType}`} style={{ fontSize: 15, color: '#4338ca', fontWeight: 700 }}>
          {REPORT_LABEL[reportType]} 페이지에서 생성 →
        </Link>
      </FieldRow>

      <div style={{ fontSize: 15, color: '#0f172a', fontWeight: 700, marginTop: 20, marginBottom: 10 }}>생성 이력</div>
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
