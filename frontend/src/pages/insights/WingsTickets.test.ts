// WingsTickets.tsx의 compareRows()·isRepeatTicket() 유닛 테스트.
// compareRows: 표 헤더 클릭 정렬의 실제 비교 로직 — 특히 "상담 건수 1순위, 동률이면 경과일
// 2순위"라는 기본 정렬 요건과, 그 외 컬럼은 단순 단일 기준 정렬이라는 점을 검증한다.
// isRepeatTicket: "여러번 상담" KPI 카드 필터 조건("같은 티켓 2회+ 언급").
import { describe, it, expect } from 'vitest'
import { compareRows, isRepeatTicket } from './WingsTickets'
import type { InsightWings } from '../../api/client'

function ticket(overrides: Partial<InsightWings>): InsightWings {
  return {
    ticket_id: '1', cs_count: 2, memos: [], first_date: '2024-01-01 00:00:00', latest_date: '2024-01-01 00:00:00',
    student_id: null, parent_id: null, category: null, ...overrides,
  }
}

describe('compareRows', () => {
  it('cs_count 내림차순이 기본이다', () => {
    const a = ticket({ ticket_id: '1', cs_count: 5 })
    const b = ticket({ ticket_id: '2', cs_count: 2 })
    expect(compareRows(a, b, 'cs_count', 'desc')).toBeLessThan(0) // a가 앞
  })

  it('cs_count가 같으면 경과일(더 오래된 first_date)이 앞선다 — 2차 정렬', () => {
    const older = ticket({ ticket_id: '1', cs_count: 3, first_date: '2020-01-01 00:00:00' })
    const newer = ticket({ ticket_id: '2', cs_count: 3, first_date: '2024-01-01 00:00:00' })
    expect(compareRows(older, newer, 'cs_count', 'desc')).toBeLessThan(0) // 더 오래된 쪽이 앞
  })

  it('cs_count asc로 뒤집으면 경과일 2차 정렬도 같이 뒤집힌다', () => {
    const older = ticket({ ticket_id: '1', cs_count: 3, first_date: '2020-01-01 00:00:00' })
    const newer = ticket({ ticket_id: '2', cs_count: 3, first_date: '2024-01-01 00:00:00' })
    expect(compareRows(older, newer, 'cs_count', 'asc')).toBeGreaterThan(0) // 최근 쪽이 앞
  })

  it('cs_count가 아닌 다른 키는 2차 정렬(경과일) 없이 단일 기준으로만 비교한다', () => {
    const a = ticket({ ticket_id: '1', cs_count: 5, category: '기타' })
    const b = ticket({ ticket_id: '2', cs_count: 5, category: '기타' })
    expect(compareRows(a, b, 'category', 'desc') === 0).toBe(true)
  })

  it('parent_id는 숫자 비교하고, null은 가장 작은 값 취급한다', () => {
    const withParent = ticket({ ticket_id: '1', parent_id: 200000 })
    const noParent = ticket({ ticket_id: '2', parent_id: null })
    expect(compareRows(withParent, noParent, 'parent_id', 'desc')).toBeLessThan(0)
  })

  it('category는 한글 문자열 비교(오름차순)', () => {
    const a = ticket({ ticket_id: '1', category: '기기·하드웨어 오류' })
    const b = ticket({ ticket_id: '2', category: '네트워크·앱 오류' })
    expect(compareRows(a, b, 'category', 'asc')).toBeLessThan(0)
  })

  it('first_date 문자열 비교로 정렬된다', () => {
    const older = ticket({ ticket_id: '1', first_date: '2024-01-01 00:00:00' })
    const newer = ticket({ ticket_id: '2', first_date: '2024-06-01 00:00:00' })
    expect(compareRows(older, newer, 'first_date', 'asc')).toBeLessThan(0)
  })
})

describe('isRepeatTicket', () => {
  it('cs_count가 1이면 여러번 상담이 아니다', () => {
    expect(isRepeatTicket(ticket({ cs_count: 1 }))).toBe(false)
  })

  it('cs_count가 2 이상이면 여러번 상담이다', () => {
    expect(isRepeatTicket(ticket({ cs_count: 2 }))).toBe(true)
  })
})
