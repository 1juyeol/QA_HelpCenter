// JiraBugs.tsx의 getAgeDays()·isPendingReview()·isSixMonthOrMore()·isOneYearOrMore()·
// compareRows() 유닛 테스트.
import { describe, it, expect } from 'vitest'
import { getAgeDays, isPendingReview, isSixMonthOrMore, isOneYearOrMore, compareRows, getLatestSyncedAt } from './JiraBugs'
import type { JiraBug } from '../../api/client'

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
}

function bug(overrides: Partial<JiraBug>): JiraBug {
  return { key: 'DQ-1', summary: '요약', status: '미해결', created_at: daysAgo(1), synced_at: null, ...overrides }
}

describe('getAgeDays', () => {
  it('오늘 생성된 이슈는 0일이다', () => {
    expect(getAgeDays(bug({ created_at: daysAgo(0) }))).toBe(0)
  })

  it('생성일로부터 경과된 일수를 반환한다', () => {
    expect(getAgeDays(bug({ created_at: daysAgo(10) }))).toBe(10)
  })
})

describe('isPendingReview', () => {
  it('상태가 미해결이면 검토 대기다', () => {
    expect(isPendingReview(bug({ status: '미해결' }))).toBe(true)
  })

  it('상태가 미해결이 아니면 검토 대기가 아니다', () => {
    expect(isPendingReview(bug({ status: '검토 중' }))).toBe(false)
  })
})

describe('isSixMonthOrMore / isOneYearOrMore', () => {
  it('180일 미만이면 6개월 이상이 아니다', () => {
    expect(isSixMonthOrMore(bug({ created_at: daysAgo(179) }))).toBe(false)
  })

  it('180일 이상이면 6개월 이상이다', () => {
    // 정확히 경계값 대신 여유를 둔다 — daysAgo()와 getAgeDays() 양쪽이 각자 Date.now()를
    // 호출하는 사이 밀리초 단위로 시간이 흘러 경계값 근처에서 간헐적으로 흔들릴 수 있다.
    expect(isSixMonthOrMore(bug({ created_at: daysAgo(181) }))).toBe(true)
  })

  it('365일 미만이면 1년 이상이 아니다', () => {
    expect(isOneYearOrMore(bug({ created_at: daysAgo(364) }))).toBe(false)
  })

  it('365일 이상이면 1년 이상이면서 6개월 이상이기도 하다 — 중첩 구간', () => {
    const old = bug({ created_at: daysAgo(400) })
    expect(isOneYearOrMore(old)).toBe(true)
    expect(isSixMonthOrMore(old)).toBe(true)
  })
})

describe('compareRows', () => {
  it('key는 문자열 비교로 정렬된다', () => {
    const a = bug({ key: 'DQ-1' })
    const b = bug({ key: 'DQ-2' })
    expect(compareRows(a, b, 'key', 'asc')).toBeLessThan(0)
  })

  it('status는 문자열 비교로 정렬된다', () => {
    const a = bug({ status: '미해결' })
    const b = bug({ status: '진행 중' })
    expect(compareRows(a, b, 'status', 'asc')).not.toBe(0)
  })

  it('created_at은 날짜 문자열 비교로 정렬된다', () => {
    const older = bug({ created_at: '2024-01-01' })
    const newer = bug({ created_at: '2024-06-01' })
    expect(compareRows(older, newer, 'created_at', 'asc')).toBeLessThan(0)
  })

  it('ageDays는 오래 방치된 이슈가 desc에서 앞선다', () => {
    const old = bug({ created_at: daysAgo(400) })
    const recent = bug({ created_at: daysAgo(1) })
    expect(compareRows(old, recent, 'ageDays', 'desc')).toBeLessThan(0)
  })

  it('asc로 뒤집으면 순서도 뒤집힌다', () => {
    const old = bug({ created_at: daysAgo(400) })
    const recent = bug({ created_at: daysAgo(1) })
    expect(compareRows(old, recent, 'ageDays', 'asc')).toBeGreaterThan(0)
  })
})

describe('getLatestSyncedAt', () => {
  it('빈 목록이면 null이다', () => {
    expect(getLatestSyncedAt([])).toBeNull()
  })

  it('목록 순서와 무관하게 가장 최근 synced_at을 찾는다', () => {
    const bugs = [
      bug({ synced_at: '2026-09-01 18:20:50' }),
      bug({ synced_at: '2026-09-04 11:47:47' }),
      bug({ synced_at: '2026-09-02 09:00:00' }),
    ]
    expect(getLatestSyncedAt(bugs)).toBe('2026-09-04 11:47:47')
  })

  it('synced_at이 없는 이슈는 무시한다', () => {
    const bugs = [bug({ synced_at: null }), bug({ synced_at: '2026-09-04 11:47:47' })]
    expect(getLatestSyncedAt(bugs)).toBe('2026-09-04 11:47:47')
  })
})
