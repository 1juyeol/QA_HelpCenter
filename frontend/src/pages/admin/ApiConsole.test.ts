// ApiConsole.tsx의 groupByDay() 유닛 테스트.
// 한도 초과일 호출 이력을 날짜별로 접는 아코디언에 쓰인다 — id 내림차순으로 들어오는
// 로그 목록을 날짜 경계에서만 끊어서 묶는지 검증한다.
import { describe, it, expect } from 'vitest'
import { groupByDay } from './ApiConsole'
import type { CollectionLogEntry } from '../../api/client'

function entry(id: number, collectedAt: string): CollectionLogEntry {
  return { id, collected_at: collectedAt, count_fetched: 1, status: 'success', message: '', last_id: null, end_id: null, source: '정기' }
}

describe('groupByDay', () => {
  it('빈 배열은 빈 그룹', () => {
    expect(groupByDay([])).toEqual([])
  })

  it('같은 날짜는 하나의 그룹으로 묶인다', () => {
    const entries = [entry(3, '2026-08-26 15:00:00'), entry(2, '2026-08-26 14:00:00'), entry(1, '2026-08-26 13:00:00')]
    const groups = groupByDay(entries)
    expect(groups).toHaveLength(1)
    expect(groups[0].day).toBe('2026-08-26')
    expect(groups[0].entries).toHaveLength(3)
  })

  it('id 내림차순으로 날짜가 바뀌면 새 그룹을 시작한다', () => {
    const entries = [
      entry(5, '2026-08-26 10:00:00'), entry(4, '2026-08-26 09:00:00'),
      entry(3, '2026-08-25 20:00:00'),
      entry(2, '2026-08-24 12:00:00'), entry(1, '2026-08-24 11:00:00'),
    ]
    const groups = groupByDay(entries)
    expect(groups.map(g => g.day)).toEqual(['2026-08-26', '2026-08-25', '2026-08-24'])
    expect(groups.map(g => g.entries.length)).toEqual([2, 1, 2])
  })

  it('같은 날짜라도 중간에 다른 날짜가 끼면 별도 그룹으로 나뉜다 (연속 구간만 병합)', () => {
    const entries = [entry(3, '2026-08-26 10:00:00'), entry(2, '2026-08-25 10:00:00'), entry(1, '2026-08-26 09:00:00')]
    const groups = groupByDay(entries)
    expect(groups.map(g => g.day)).toEqual(['2026-08-26', '2026-08-25', '2026-08-26'])
  })
})
