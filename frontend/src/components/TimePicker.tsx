// 시:분을 고르는 공용 시각 선택 UI. 브라우저 기본 <input type="time">의 분 스피너는 위/아래
// 화살표나 마우스 휠로 값을 바꿀 때 59 다음에 다시 00으로, 00 이전에 다시 59로 끝없이
// 넘어가서(wrap-around) 어디가 시작이고 끝인지 감이 안 온다 — 그 대신 오전/오후·시·분을 각각
// <select> 드롭다운으로 바꿔서, 전체를 목록으로 보여주고 위/아래 끝에서 더 안 넘어가게 한다.
// 표기는 브라우저 기본 UI(오전/오후 12시간제, "오전 12:30" 형태)를 그대로 따른다 — "시"/"분"
// 같은 단위 글자는 안 붙이고 숫자만 콜론으로 잇는다.
const PERIODS: Array<'AM' | 'PM'> = ['AM', 'PM']
const PERIOD_LABEL: Record<'AM' | 'PM', string> = { AM: '오전', PM: '오후' }
const HOURS_12 = Array.from({ length: 12 }, (_, i) => i + 1) // 1~12
const MINUTES = Array.from({ length: 60 }, (_, m) => m)

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// 24시간제(0~23) ↔ 12시간제(오전/오후 + 1~12) 변환. DB·상태값은 항상 24시간제(0~23)로 유지하고
// 화면 표기만 12시간제로 바꾼다.
export function to12Hour(hour24: number): { period: 'AM' | 'PM'; hour12: number } {
  const period = hour24 < 12 ? 'AM' : 'PM'
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  return { period, hour12 }
}

export function to24Hour(period: 'AM' | 'PM', hour12: number): number {
  if (period === 'AM') return hour12 === 12 ? 0 : hour12
  return hour12 === 12 ? 12 : hour12 + 12
}

export default function TimePicker({
  hour, minute, onChange, invalid = false,
}: {
  hour: number
  minute: number
  onChange: (hour: number, minute: number) => void
  invalid?: boolean
}) {
  const { period, hour12 } = to12Hour(hour)
  const selectStyle = {
    padding: '8px 10px', border: `1px solid ${invalid ? '#ef4444' : '#e2e8f0'}`, borderRadius: 6, fontSize: 15,
    color: '#1e293b', background: '#fff', cursor: 'pointer',
  } as const

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <select value={period} onChange={e => onChange(to24Hour(e.target.value as 'AM' | 'PM', hour12), minute)} style={selectStyle}>
        {PERIODS.map(p => <option key={p} value={p}>{PERIOD_LABEL[p]}</option>)}
      </select>
      <select value={hour12} onChange={e => onChange(to24Hour(period, Number(e.target.value)), minute)} style={selectStyle}>
        {HOURS_12.map(h => <option key={h} value={h}>{pad2(h)}</option>)}
      </select>
      <span style={{ color: '#94a3b8' }}>:</span>
      <select value={minute} onChange={e => onChange(hour, Number(e.target.value))} style={selectStyle}>
        {MINUTES.map(m => <option key={m} value={m}>{pad2(m)}</option>)}
      </select>
    </div>
  )
}
