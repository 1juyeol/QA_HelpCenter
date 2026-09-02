// WeeklyReport.tsx의 formatWingsRepeatTrend() 유닛 테스트.
// "반복 Wings 티켓" 섹션 카드 아래 문장 — 지난주 대비 증감을 규칙 기반으로 표현한다.
import { describe, it, expect } from 'vitest'
import { formatWingsRepeatTrend } from './WeeklyReport'

describe('formatWingsRepeatTrend', () => {
  it('지난주 데이터가 없으면(newDelta null) 비교 없이 현재 값만 말한다', () => {
    expect(formatWingsRepeatTrend(5, null, 2)).toBe('현재 방치 중인 반복 미해결 케이스는 5건입니다.')
  })

  it('지난주 데이터가 없으면(staleDelta null) 비교 없이 현재 값만 말한다', () => {
    expect(formatWingsRepeatTrend(5, 1, null)).toBe('현재 방치 중인 반복 미해결 케이스는 5건입니다.')
  })

  it('증가는 +부호를 붙인다', () => {
    const text = formatWingsRepeatTrend(5, 2, 1)
    expect(text).toContain('신규 케이스는 +2건')
    expect(text).toContain('방치 케이스는 +1건')
    expect(text).toContain('누적 방치 건수는 5건')
  })

  it('감소는 -부호가 그대로 붙는다', () => {
    const text = formatWingsRepeatTrend(3, -2, -1)
    expect(text).toContain('신규 케이스는 -2건')
    expect(text).toContain('방치 케이스는 -1건')
  })

  it('변화 없으면 ±0건으로 표시한다', () => {
    const text = formatWingsRepeatTrend(4, 0, 0)
    expect(text).toContain('신규 케이스는 ±0건')
    expect(text).toContain('방치 케이스는 ±0건')
  })

  it('1000 이상이면 천 단위 콤마를 붙인다', () => {
    const text = formatWingsRepeatTrend(1234, 2000, 1000)
    expect(text).toContain('신규 케이스는 +2,000건')
    expect(text).toContain('방치 케이스는 +1,000건')
    expect(text).toContain('누적 방치 건수는 1,234건')
  })
})
