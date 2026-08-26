// MailingSettings.tsx의 hasMinDeadlineGap()/withDefaultDomain() 유닛 테스트.
// hasMinDeadlineGap()은 backend/core/mail_settings.py의 has_min_deadline_gap()과 같은
// 규칙(최소 10분 간격)을 프론트에서도 저장 전에 먼저 검증하기 위한 함수라, 백엔드 테스트와
// 대응되는 케이스로 작성했다.
import { describe, it, expect } from 'vitest'
import { hasMinDeadlineGap, MIN_DEADLINE_SEND_GAP_MINUTES, withDefaultDomain, DEFAULT_EMAIL_DOMAIN } from './MailingSettings'

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
