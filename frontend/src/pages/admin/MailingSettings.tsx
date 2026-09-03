// 일별/주간 보고서 자동 메일 발송 설정 화면. "자동화 관리" 페이지(AutomationManagement.tsx)의
// "일별 보고서 발송"/"주간 보고서 발송" 탭이 이 파일이 내보내는 MailSettingsSection을
// report_type만 바꿔 그대로 가져다 쓴다 — 둘 다 UI·로직이 거의 같아서 한 컴포넌트를 재사용한다.
//
// 섹션 안에서: on/off, 보고서 마감 시각(이 시각까지 보고서가 만들어져 있어야 발송), 발송
// 시각, 발신자, 수신자(여러 명, 태그 형태로 입력), 날짜를 골라 즉시 테스트 발송, 발신
// 이력을 보여준다. 발신 이력은 별도 API·별도 표시 형식 없이 기존 감사 로그(GET /api/audit/log)를
// action='daily_report_mail'|'weekly_report_mail'로 필터링해서, AuditLog.tsx가 내보내는
// AuditLogRow 컴포넌트를 그대로 가져다 쓴다 — 감사 로그가 모든 자동화 이력의 기준이고, 이
// 페이지는 그중 메일 관련 항목만 걸러서 보여주는 것일 뿐이라는 원칙 때문이다.
//
// 저장하면(POST /api/mail-settings) 백엔드가 그 즉시 스케줄을 새 시각으로 재등록한다 —
// 서버 재시작 없이 다음 발송부터 바뀐 설정이 반영된다.
//
// 테스트 발송은 날짜를 직접 골라서 보낼 수 있다 — 평소 자동 발송(직전 영업일/직전 주)과
// 별개로, 특정 날짜 보고서를 확인하고 싶을 때를 위함이다. 고른 날짜에 보고서가 없으면
// 발송 버튼 대신 "만들러 가기" 링크를 보여준다(report_screenshot.py가 캡쳐할 대상 자체가
// 없어서 발송이 애초에 불가능하기 때문).
//
// 발신은 회사 그룹웨어 SMTP(backend/features/mailer/mail_client.py, gm.danbiedu.co.kr)로
// 나간다 — 사내망 전용 서버라 VPN이 연결되어 있지 않으면 연결 자체가 타임아웃나서 발송이
// 실패한다. 이 페이지 상단에 그 사실을 눈에 띄게 안내한다(VpnNotice).
import { useEffect, useState, type KeyboardEvent } from 'react'
import { api, type MailSettings, type AuditLogEntry } from '../../api/client'
import { useAdmin } from '../../hooks/useAdmin'
import FieldRow from '../../components/FieldRow'
import WarningBanner from '../../components/WarningBanner'
import HistoryList from '../../components/HistoryList'
import TimePicker from '../../components/TimePicker'

const REPORT_LABEL: Record<MailSettings['report_type'], string> = {
  daily: '일별 보고서',
  weekly: '주간 보고서',
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// 발신자·수신자 대부분이 회사 도메인이라, 아이디만 입력해도 자동으로 도메인을 붙여준다.
// 이미 "@"가 있으면(다른 도메인 이메일이면) 그대로 둔다 — 회사 도메인이 아닌 주소도
// 그대로 쓸 수 있어야 하기 때문이다.
export const DEFAULT_EMAIL_DOMAIN = '@danbiedu.co.kr'

export function withDefaultDomain(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.includes('@')) return trimmed
  return trimmed + DEFAULT_EMAIL_DOMAIN
}

// toISOString()은 UTC 기준으로 변환하므로, KST(UTC+9)에서는 자정 근처(0~8시대) 날짜가
// 하루 밀려서 잘못 계산된다 — 반드시 로컬 날짜 구성요소를 직접 조립한다.
function toLocalDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function yesterday(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return toLocalDateString(d)
}

// 주간 보고서는 week_start가 반드시 월요일이어야 해서(정책), 사용자가 아무 날짜나 골라도
// 그 주의 월요일로 자동 보정한다.
export function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  const day = d.getDay()
  const diff = (day === 0 ? -6 : 1) - day
  d.setDate(d.getDate() + diff)
  return toLocalDateString(d)
}

// "8월 3주차" 형식 라벨. 이 화면이 다루는 대상이 주간 보고서라, 그 주 선택 드롭다운에 쓰는
// WeeklyReport.tsx의 getWeekLabel과 반드시 같은 기준으로 맞춘다 — Dashboard.tsx/
// CaseRiskSection.tsx 등 차트 축 라벨에 쓰는 monthWeekLabel은 "그 달 1일이 속한 주(전달로
// 넘어갈 수 있음)"를 1주차로 세는 다른 기준이라, 그대로 가져다 쓰면 같은 주인데도 여기와
// 주간보고서 화면에서 번호가 다르게 보인다.
export function getWeekLabel(mondayStr: string): string {
  const d = new Date(mondayStr + 'T12:00:00')
  const year = d.getFullYear()
  const month = d.getMonth()
  const firstDay = new Date(year, month, 1)
  const firstDow = firstDay.getDay()
  const daysToFirstMon = (1 - firstDow + 7) % 7
  const firstMonDate = 1 + daysToFirstMon
  const weekNum = Math.floor((d.getDate() - firstMonDate) / 7) + 1
  return `${month + 1}월 ${weekNum}주차`
}

function lastMonday(): string {
  const d = new Date()
  d.setDate(d.getDate() - 7)
  return mondayOf(toLocalDateString(d))
}

// 백엔드(core/mail_settings.py의 MIN_DEADLINE_SEND_GAP_MINUTES/has_min_deadline_gap)와
// 반드시 같이 유지한다 — 저장 버튼을 누르기 전에 프론트에서 먼저 걸러서 불필요한 요청
// 왕복 없이 바로 알려주기 위한 것이고, 최종 검증은 서버가 한다.
export const MIN_DEADLINE_SEND_GAP_MINUTES = 10

export function hasMinDeadlineGap(deadlineHour: number, deadlineMinute: number, sendHour: number, sendMinute: number): boolean {
  const deadlineTotal = deadlineHour * 60 + deadlineMinute
  const sendTotal = sendHour * 60 + sendMinute
  return deadlineTotal <= sendTotal - MIN_DEADLINE_SEND_GAP_MINUTES
}

function VpnNotice() {
  return (
    <WarningBanner>
      ⚠️ 이 메일은 <strong>사내망 전용 서버(gm.danbiedu.co.kr)</strong>로 발송됩니다. <strong>VPN이 연결되어 있지 않으면 발송이 실패합니다.</strong> 재택 등 사외에서는 먼저 VPN을 켜주세요.
    </WarningBanner>
  )
}

function RecipientsInput({ value, onChange, showDomainHint = false }: { value: string[]; onChange: (v: string[]) => void; showDomainHint?: boolean }) {
  const [text, setText] = useState('')

  function commit() {
    const trimmed = withDefaultDomain(text.replace(/,$/, ''))
    if (trimmed && !value.includes(trimmed)) onChange([...value, trimmed])
    setText('')
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commit()
    }
  }

  return (
    <div>
      {value.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {value.map(email => (
            <span
              key={email}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, background: '#eef2ff',
                color: '#4338ca', borderRadius: 6, padding: '6px 10px', fontSize: 14,
              }}
            >
              {email}
              <button
                onClick={() => onChange(value.filter(v => v !== email))}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#4338ca', fontWeight: 700, padding: 0, fontSize: 16, lineHeight: 1 }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        type="text"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commit}
        placeholder="아이디 또는 이메일, Enter로 추가"
        style={{ padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 14, width: '100%', maxWidth: 420, boxSizing: 'border-box' }}
      />
      {showDomainHint && (
        <div style={{ fontSize: 15, color: '#334155', marginTop: 6, lineHeight: 1.6 }}>
          아이디만 입력해도 <strong>{DEFAULT_EMAIL_DOMAIN}</strong>이 자동으로 붙습니다. 다른 도메인 주소면 전체 이메일을 입력하세요.
        </div>
      )}
    </div>
  )
}

function TestSendControl({ reportType, adminToken, onSent }: { reportType: MailSettings['report_type']; adminToken: string; onSent: () => void }) {
  const [pickedDate, setPickedDate] = useState(() => reportType === 'daily' ? yesterday() : lastMonday())
  const [testRecipients, setTestRecipients] = useState<string[]>([])
  const [exists, setExists] = useState<boolean | null>(null)
  const [testing, setTesting] = useState(false)

  const targetDate = reportType === 'weekly' ? mondayOf(pickedDate) : pickedDate
  const canSend = exists === true && testRecipients.length > 0

  useEffect(() => {
    let cancelled = false
    setExists(null)
    const check = reportType === 'daily' ? api.fetchDailyReport(targetDate) : api.fetchWeeklyReport(targetDate)
    check.then(() => { if (!cancelled) setExists(true) }).catch(() => { if (!cancelled) setExists(false) })
    return () => { cancelled = true }
  }, [reportType, targetDate])

  async function testSend() {
    setTesting(true)
    try {
      await api.testMailSend(reportType, adminToken, testRecipients, targetDate)
    } finally {
      setTesting(false)
      onSent()
    }
  }

  const reportLink = reportType === 'daily' ? `/report/daily?date=${targetDate}` : `/report/weekly?week_start=${targetDate}`

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 15, color: '#334155', marginBottom: 6, lineHeight: 1.7 }}>
          테스트 수신자 (저장된 자동 발송 수신자와 별개입니다 — 직접 입력해야 발송됩니다)
        </div>
        <RecipientsInput value={testRecipients} onChange={setTestRecipients} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <input
          type="date" value={pickedDate} max={yesterday()} onChange={e => setPickedDate(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 14 }}
        />
        {exists === false ? (
          <a
            href={reportLink}
            style={{ fontSize: 14, color: '#4338ca', fontWeight: 700, padding: '8px 4px' }}
          >
            이 날짜 보고서가 없습니다 — 만들러 가기 →
          </a>
        ) : (
          <button
            onClick={testSend} disabled={testing || !canSend}
            style={{
              padding: '9px 18px', background: canSend ? '#fff' : '#f1f5f9',
              color: canSend ? '#4338ca' : '#94a3b8', border: '1px solid #4338ca',
              borderColor: canSend ? '#4338ca' : '#e2e8f0', borderRadius: 6, fontSize: 14,
              fontWeight: 700, cursor: canSend ? 'pointer' : 'default',
            }}
          >
            {testing ? '발송 중...' : exists === null ? '확인 중...' : exists === true && testRecipients.length === 0 ? '테스트 수신자를 입력하세요' : '이 보고서로 테스트 발송'}
          </button>
        )}
      </div>
      {reportType === 'weekly' && (
        <div style={{ fontSize: 15, color: '#334155', marginTop: 6, lineHeight: 1.7 }}>
          주간 보고서는 월요일 기준이라 {getWeekLabel(targetDate)}({targetDate})로 자동 보정해서 확인합니다.
        </div>
      )}
    </div>
  )
}

export function MailSettingsSection({ reportType }: { reportType: MailSettings['report_type'] }) {
  const { adminToken } = useAdmin()
  const [settings, setSettings] = useState<MailSettings | null>(null)
  const [history, setHistory] = useState<AuditLogEntry[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  function loadHistory(token: string) {
    api.fetchAuditLog(token, 200)
      .then(entries => setHistory(entries.filter(e => e.action === `${reportType}_report_mail`)))
      .catch(() => setHistory([]))
  }

  useEffect(() => {
    if (!adminToken) return
    setSettings(null)
    setHistory(null)
    api.fetchMailSettings(reportType, adminToken).then(setSettings).catch(() => {})
    loadHistory(adminToken)
  }, [adminToken, reportType])

  async function save() {
    if (!settings || !adminToken) return
    if (!hasMinDeadlineGap(settings.deadline_hour, settings.deadline_minute, settings.send_hour, settings.send_minute)) {
      setMessage(`보고서 마감 시각은 발송 시각보다 최소 ${MIN_DEADLINE_SEND_GAP_MINUTES}분 이상 앞서 있어야 합니다.`)
      return
    }
    setSaving(true)
    setMessage('')
    try {
      const saved = await api.saveMailSettings(settings, adminToken)
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
    if (!window.confirm(`${REPORT_LABEL[reportType]} 메일링 설정을 기본값으로 되돌릴까요? 발신자·수신자를 포함한 지금 설정이 사라집니다.`)) return
    setSaving(true)
    setMessage('')
    try {
      const reset = await api.resetMailSettings(reportType, adminToken)
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

  const sendTime = `${pad2(settings.send_hour)}:${pad2(settings.send_minute)}`
  const gapValid = hasMinDeadlineGap(settings.deadline_hour, settings.deadline_minute, settings.send_hour, settings.send_minute)

  function updateTime(field: 'deadline' | 'send', h: number, m: number) {
    setSettings(s => s && { ...s, [`${field}_hour`]: h, [`${field}_minute`]: m })
  }

  return (
    <div className="section-card">
      <VpnNotice />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>{REPORT_LABEL[reportType]} 메일링 설정</h2>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#0f172a', fontWeight: 700, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={e => setSettings({ ...settings, enabled: e.target.checked })}
          />
          자동 발송 켜짐 (끄면 설정은 유지되고 발송만 안 함)
        </label>
      </div>

      <FieldRow
        label="보고서 마감 시각"
        hint={`이 시각까지 대상 날짜의 보고서가 만들어져 있어야 발송합니다. 이 시각을 넘겨서 보고서가 생성되면 그날은 발송하지 않고 건너뜁니다. 발송 시각보다 최소 ${MIN_DEADLINE_SEND_GAP_MINUTES}분 이상 앞서 있어야 합니다.`}
      >
        <TimePicker
          hour={settings.deadline_hour} minute={settings.deadline_minute}
          onChange={(h, m) => updateTime('deadline', h, m)}
          invalid={!gapValid}
        />
        {!gapValid && (
          <span style={{ fontSize: 15, color: '#ef4444', fontWeight: 700, marginLeft: 10 }}>
            발송 시각({sendTime})보다 최소 {MIN_DEADLINE_SEND_GAP_MINUTES}분 이상 앞서야 합니다.
          </span>
        )}
      </FieldRow>

      <FieldRow label="발송 시각" hint="메일이 실제로 발송되는 시각입니다. 저장하면 바로 이 시각으로 다음 발송부터 반영됩니다.">
        <TimePicker hour={settings.send_hour} minute={settings.send_minute} onChange={(h, m) => updateTime('send', h, m)} />
      </FieldRow>

      <FieldRow label="발신자" hint={`여기 입력한 주소가 그대로 발신자로 표시됩니다 (그룹웨어 계정 주소). 아이디만 입력해도 ${DEFAULT_EMAIL_DOMAIN}이 자동으로 붙습니다.`}>
        <input
          type="text" value={settings.sender_email}
          onChange={e => setSettings({ ...settings, sender_email: e.target.value })}
          onBlur={e => setSettings(s => s && { ...s, sender_email: withDefaultDomain(e.target.value) })}
          placeholder="jylee"
          style={{ padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 14, width: 300 }}
        />
      </FieldRow>

      <FieldRow label="수신자">
        <RecipientsInput
          value={settings.recipients}
          onChange={recipients => setSettings({ ...settings, recipients })}
          showDomainHint
        />
      </FieldRow>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
        <button
          onClick={save} disabled={saving || !gapValid}
          style={{
            padding: '9px 18px', background: gapValid ? '#4338ca' : '#c7d2fe', color: '#fff',
            border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 700,
            cursor: gapValid ? 'pointer' : 'default',
          }}
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

      <FieldRow label="날짜를 골라 지금 테스트 발송">
        {adminToken && (
          <TestSendControl reportType={reportType} adminToken={adminToken} onSent={() => adminToken && loadHistory(adminToken)} />
        )}
      </FieldRow>

      <div style={{ fontSize: 15, color: '#0f172a', fontWeight: 700, marginTop: 20, marginBottom: 10 }}>발신 이력</div>
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

