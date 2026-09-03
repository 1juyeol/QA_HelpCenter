// MailingSettings.tsx의 hasMinDeadlineGap()/withDefaultDomain()/mondayOf() 유닛 테스트.
// hasMinDeadlineGap()은 backend/core/mail_settings.py의 has_min_deadline_gap()과 같은
// 규칙(최소 10분 간격)을 프론트에서도 저장 전에 먼저 검증하기 위한 함수라, 백엔드 테스트와
// 대응되는 케이스로 작성했다.
// mondayOf()는 예전에 toISOString().slice(0,10)으로 날짜를 뽑아서, UTC보다 앞선 시간대
// (KST 등)에서 자정 근처 날짜가 하루 밀리는 버그가 있었다(2026-08-23 → 2026-08-17이어야
// 하는데 2026-08-16으로 계산됨) — 로컬 날짜 구성요소를 직접 조립하도록 고친 뒤 회귀
// 방지용으로 작성.
import { describe, it, expect } from 'vitest'
import { hasMinDeadlineGap, MIN_DEADLINE_SEND_GAP_MINUTES, withDefaultDomain, DEFAULT_EMAIL_DOMAIN, mondayOf, getWeekLabel } from './MailingSettings'

describe('hasMinDeadlineGap', () => {
  it('정확히 10분 차이면 유효하다', () => {
    expect(hasMinDeadlineGap(10, 50, 11, 0)).toBe(true)
  })

  it('10분보다 여유가 많으면 유효하다', () => {
    expect(hasMinDeadlineGap(10, 0, 11, 0)).toBe(true)
  })

  it('10분보다 적게 떨어져 있으면 무효하다', () => {
    expect(hasMinDeadlineGap(10, 55, 11, 0)).toBe(false)
  })

  it('마감 시각과 발송 시각이 같으면 무효하다', () => {
    expect(hasMinDeadlineGap(11, 0, 11, 0)).toBe(false)
  })

  it('마감 시각이 발송 시각보다 늦으면 무효하다', () => {
    expect(hasMinDeadlineGap(11, 30, 11, 0)).toBe(false)
  })

  it('상수가 실제로 10분인지 확인', () => {
    expect(MIN_DEADLINE_SEND_GAP_MINUTES).toBe(10)
  })
})

describe('withDefaultDomain', () => {
  it('아이디만 입력하면 기본 도메인을 붙인다', () => {
    expect(withDefaultDomain('jylee')).toBe(`jylee${DEFAULT_EMAIL_DOMAIN}`)
  })

  it('앞뒤 공백은 지우고 붙인다', () => {
    expect(withDefaultDomain('  jylee  ')).toBe(`jylee${DEFAULT_EMAIL_DOMAIN}`)
  })

  it('이미 도메인이 있으면(다른 이메일) 그대로 둔다', () => {
    expect(withDefaultDomain('someone@gmail.com')).toBe('someone@gmail.com')
  })

  it('빈 문자열은 그대로 빈 문자열이다', () => {
    expect(withDefaultDomain('   ')).toBe('')
  })
})

describe('mondayOf', () => {
  it('일요일을 고르면 그 주의 월요일(전날)로 보정한다', () => {
    expect(mondayOf('2026-08-23')).toBe('2026-08-17')
  })

  it('월요일을 고르면 그대로 반환한다', () => {
    expect(mondayOf('2026-08-17')).toBe('2026-08-17')
  })

  it('주 중간 날짜를 고르면 그 주의 월요일로 보정한다', () => {
    expect(mondayOf('2026-08-19')).toBe('2026-08-17')
  })

  it('토요일을 고르면 그 주의 월요일로 보정한다', () => {
    expect(mondayOf('2026-08-22')).toBe('2026-08-17')
  })
})

describe('getWeekLabel', () => {
  // WeeklyReport.tsx의 getWeekLabel과 반드시 같은 결과가 나와야 한다 — 주간보고서 화면의
  // 주차 번호와 여기 표시가 어긋나면 안 된다.
  it('8월 3주차(2026-08-17)를 올바르게 표기한다', () => {
    expect(getWeekLabel('2026-08-17')).toBe('8월 3주차')
  })

  it('8월 4주차(2026-08-24)를 올바르게 표기한다', () => {
    expect(getWeekLabel('2026-08-24')).toBe('8월 4주차')
  })
})
