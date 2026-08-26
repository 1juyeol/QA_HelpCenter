// TimePicker.tsx의 to12Hour()/to24Hour() 유닛 테스트.
// 24시간제(DB·상태값 저장 형식) ↔ 12시간제(오전/오후, 화면 표기) 변환이 자정·정오
// 경계에서 올바른지 검증한다.
import { describe, it, expect } from 'vitest'
import { to12Hour, to24Hour } from './TimePicker'

describe('to12Hour', () => {
  it('자정(0시)은 오전 12시', () => {
    expect(to12Hour(0)).toEqual({ period: 'AM', hour12: 12 })
  })

  it('오전 시간대는 그대로', () => {
    expect(to12Hour(9)).toEqual({ period: 'AM', hour12: 9 })
  })

  it('정오(12시)는 오후 12시', () => {
    expect(to12Hour(12)).toEqual({ period: 'PM', hour12: 12 })
  })

  it('오후 시간대는 12를 뺀다', () => {
    expect(to12Hour(21)).toEqual({ period: 'PM', hour12: 9 })
  })

  it('23시는 오후 11시', () => {
    expect(to12Hour(23)).toEqual({ period: 'PM', hour12: 11 })
  })
})

describe('to24Hour', () => {
  it('오전 12시는 0시', () => {
    expect(to24Hour('AM', 12)).toBe(0)
  })

  it('오전 시간대는 그대로', () => {
    expect(to24Hour('AM', 9)).toBe(9)
  })

  it('오후 12시는 12시', () => {
    expect(to24Hour('PM', 12)).toBe(12)
  })

  it('오후 시간대는 12를 더한다', () => {
    expect(to24Hour('PM', 9)).toBe(21)
  })

  it('to12Hour와 왕복 변환이 일치한다', () => {
    for (let h = 0; h < 24; h++) {
      const { period, hour12 } = to12Hour(h)
      expect(to24Hour(period, hour12)).toBe(h)
    }
  })
})
