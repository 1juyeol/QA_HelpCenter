// RepeatParents.tsx의 순수 함수 유닛 테스트.
// hasConsecutiveRepeat()은 예전 "동일 이슈 반복"(대분류만 같으면, 순서·인접 여부 무관하게
// 카운트되던) 기준의 허점 — 중간에 완전히 다른 이슈가 껴 있어도 반복으로 잡히던 문제 — 를
// "시간순으로 바로 인접한 두 상담이 소분류까지 완전히 같아야 한다"로 좁힌 것이라, 그 허점이
// 실제로 고쳐졌는지가 핵심 테스트 대상이다.
//
// getQualifyingMemos()가 Date.now() 기준 최근 90일보다 오래된 메모를 걸러내므로(자격 판정·
// 상담 건수·유형 분포 등이 전부 이 함수를 거친다), 테스트 날짜를 '2026-08-01'처럼 고정 문자열로
// 쓰면 시간이 지나 실제 날짜가 그 90일 창을 벗어나는 순간 테스트가 코드 변경 없이 저절로
// 깨진다. 그래서 모든 메모 날짜는 daysAgo()로 "오늘로부터 N일 전"을 계산해서 쓴다.
import { describe, it, expect } from 'vitest'
import {
  isQualified, hasConsecutiveRepeat, hasRecentShortGap, isComplexIssue,
  typesWithCounts, compareRows, getDisplayCount, getFirstDate, rowsForCategory,
} from './RepeatParents'
import type { InsightParent } from '../../api/client'

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString()
}

function parent(overrides: Partial<InsightParent> & { memos: InsightParent['memos'] }): InsightParent {
  return {
    parent_id: '123456',
    cs_count: overrides.memos.length,
    categories: [],
    latest_date: overrides.memos[overrides.memos.length - 1]?.date ?? daysAgo(30),
    ...overrides,
  }
}

describe('isQualified', () => {
  it('90일 이내 자격 조건을 만족하는 메모가 3건 이상이면 true', () => {
    const r = parent({
      memos: [
        { memo: 'a', date: daysAgo(30), category: '네트워크·앱 오류 > 와이파이 오류' },
        { memo: 'b', date: daysAgo(20), category: '네트워크·앱 오류 > 앱 오류' },
        { memo: 'c', date: daysAgo(10), category: '기기·하드웨어 오류 > 충전 불량' },
      ],
    })
    expect(isQualified(r)).toBe(true)
  })

  it('90일 이내 메모가 2건뿐이면 false', () => {
    const r = parent({
      memos: [
        { memo: 'a', date: daysAgo(30), category: '네트워크·앱 오류 > 와이파이 오류' },
        { memo: 'b', date: daysAgo(20), category: '네트워크·앱 오류 > 앱 오류' },
      ],
    })
    expect(isQualified(r)).toBe(false)
  })

  it('"기타" 카테고리도 다른 카테고리와 동일하게 카운트된다 (리스크 화이트리스트로 좁히지 않음)', () => {
    const r = parent({
      memos: [
        { memo: 'a', date: daysAgo(30), category: '기타 > 기타' },
        { memo: 'b', date: daysAgo(20), category: '기타 > 교사 상담 요청' },
        { memo: 'c', date: daysAgo(10), category: '체험 관련 > 중복 신청' },
      ],
    })
    expect(isQualified(r)).toBe(true)
  })

  it('90일보다 오래된 메모는 자격 판정에서 제외된다 (최근 3개월 데이터만 다루는 핵심 동작)', () => {
    const r = parent({
      memos: [
        { memo: 'a', date: daysAgo(200), category: '네트워크·앱 오류 > 와이파이 오류' },
        { memo: 'b', date: daysAgo(150), category: '네트워크·앱 오류 > 앱 오류' },
        { memo: 'c', date: daysAgo(120), category: '기기·하드웨어 오류 > 충전 불량' },
        { memo: 'd', date: daysAgo(10), category: '기기·하드웨어 오류 > 분실, 파손' },
      ],
    })
    // 90일 이내인 건 마지막 한 건뿐 — 백엔드 기준(180일)으로는 3건이 넘어도 이 페이지에선 미달.
    expect(isQualified(r)).toBe(false)
  })

  it('89일 전처럼 경계에 가까운 날짜도 90일 이내로 포함된다', () => {
    // 정확히 90일 전을 쓰면 fixture 생성 시점과 getQualifyingMemos 실행 시점의 Date.now()가
    // 몇 ms 차이로 갈려서 드물게 false가 나올 수 있다(둘 다 실제 시계를 따로 호출하기 때문) —
    // 그래서 경계에 딱 붙이지 않고 89일로 안전 마진을 둔다.
    const r = parent({
      memos: [
        { memo: 'a', date: daysAgo(89), category: '네트워크·앱 오류 > 와이파이 오류' },
        { memo: 'b', date: daysAgo(50), category: '네트워크·앱 오류 > 앱 오류' },
        { memo: 'c', date: daysAgo(10), category: '기기·하드웨어 오류 > 충전 불량' },
      ],
    })
    expect(isQualified(r)).toBe(true)
  })
})

describe('hasConsecutiveRepeat', () => {
  it('바로 인접한 두 상담이 소분류까지 같으면 true', () => {
    const r = parent({
      memos: [
        { memo: 'a', date: daysAgo(30), category: '기기·하드웨어 오류 > 충전 불량' },
        { memo: 'b', date: daysAgo(20), category: '기기·하드웨어 오류 > 충전 불량' },
        { memo: 'c', date: daysAgo(10), category: '네트워크·앱 오류 > 와이파이 오류' },
      ],
    })
    expect(hasConsecutiveRepeat(r)).toBe(true)
  })

  it('대분류만 같고 소분류가 다르면 false (예전 기준의 허점 수정 확인)', () => {
    const r = parent({
      memos: [
        { memo: 'a', date: daysAgo(30), category: '기기·하드웨어 오류 > 충전 불량' },
        { memo: 'b', date: daysAgo(20), category: '기기·하드웨어 오류 > 분실, 파손' },
        { memo: 'c', date: daysAgo(10), category: '네트워크·앱 오류 > 와이파이 오류' },
      ],
    })
    expect(hasConsecutiveRepeat(r)).toBe(false)
  })

  it('같은 이슈가 있어도 사이에 다른 이슈가 껴서 인접하지 않으면 false', () => {
    // "기기 교체 요청 > 분실, 파손 > 기기 교체 요청"처럼 중간에 다른 이슈가 낀 경우.
    const r = parent({
      memos: [
        { memo: 'a', date: daysAgo(30), category: '교재·물류·배송 > 기기 교체 요청' },
        { memo: 'b', date: daysAgo(20), category: '기기·하드웨어 오류 > 분실, 파손' },
        { memo: 'c', date: daysAgo(10), category: '교재·물류·배송 > 기기 교체 요청' },
      ],
    })
    expect(hasConsecutiveRepeat(r)).toBe(false)
  })
})

describe('hasRecentShortGap', () => {
  it('가장 최근 두 상담 간격이 7일이면 true', () => {
    const r = parent({
      memos: [
        { memo: 'a', date: daysAgo(30), category: '네트워크·앱 오류 > 와이파이 오류' },
        { memo: 'b', date: daysAgo(17), category: '네트워크·앱 오류 > 앱 오류' },
        { memo: 'c', date: daysAgo(10), category: '기기·하드웨어 오류 > 충전 불량' },
      ],
    })
    expect(hasRecentShortGap(r)).toBe(true)
  })

  it('가장 최근 두 상담 간격이 8일이면 false', () => {
    const r = parent({
      memos: [
        { memo: 'a', date: daysAgo(30), category: '네트워크·앱 오류 > 와이파이 오류' },
        { memo: 'b', date: daysAgo(18), category: '네트워크·앱 오류 > 앱 오류' },
        { memo: 'c', date: daysAgo(10), category: '기기·하드웨어 오류 > 충전 불량' },
      ],
    })
    expect(hasRecentShortGap(r)).toBe(false)
  })
})

describe('isComplexIssue', () => {
  it('대분류가 3개 이상이면 true', () => {
    const r = parent({
      memos: [
        { memo: 'a', date: daysAgo(30), category: '네트워크·앱 오류 > 와이파이 오류' },
        { memo: 'b', date: daysAgo(20), category: '기기·하드웨어 오류 > 충전 불량' },
        { memo: 'c', date: daysAgo(10), category: '미납·결제 > 미납 관리' },
      ],
    })
    expect(isComplexIssue(r)).toBe(true)
  })

  it('대분류가 2개면 false', () => {
    const r = parent({
      memos: [
        { memo: 'a', date: daysAgo(30), category: '네트워크·앱 오류 > 와이파이 오류' },
        { memo: 'b', date: daysAgo(20), category: '네트워크·앱 오류 > 앱 오류' },
        { memo: 'c', date: daysAgo(10), category: '기기·하드웨어 오류 > 충전 불량' },
      ],
    })
    expect(isComplexIssue(r)).toBe(false)
  })
})

describe('typesWithCounts', () => {
  it('"대분류 > 소분류" 단위 건수를 빈도 내림차순으로 정리한다', () => {
    const r = parent({
      memos: [
        { memo: 'a', date: daysAgo(30), category: '기기·하드웨어 오류 > 충전·전원 불량' },
        { memo: 'b', date: daysAgo(20), category: '네트워크·앱 오류 > 와이파이 오류' },
        { memo: 'c', date: daysAgo(10), category: '기기·하드웨어 오류 > 충전·전원 불량' },
        { memo: 'd', date: daysAgo(5), category: '기기·하드웨어 오류 > 분실, 파손' },
      ],
    })
    expect(typesWithCounts(r)).toEqual([
      { category: '기기·하드웨어 오류 > 충전·전원 불량', count: 2 },
      { category: '네트워크·앱 오류 > 와이파이 오류', count: 1 },
      { category: '기기·하드웨어 오류 > 분실, 파손', count: 1 },
    ])
  })

  it('카테고리 필터가 걸려 있으면 그 대분류만 남긴다', () => {
    const r = parent({
      memos: [
        { memo: 'a', date: daysAgo(30), category: '기기·하드웨어 오류 > 충전·전원 불량' },
        { memo: 'b', date: daysAgo(20), category: '네트워크·앱 오류 > 와이파이 오류' },
        { memo: 'c', date: daysAgo(10), category: '기기·하드웨어 오류 > 분실, 파손' },
      ],
    })
    expect(typesWithCounts(r, { main: '기기·하드웨어 오류', sub: null })).toEqual([
      { category: '기기·하드웨어 오류 > 충전·전원 불량', count: 1 },
      { category: '기기·하드웨어 오류 > 분실, 파손', count: 1 },
    ])
  })
})

describe('getFirstDate', () => {
  it('자격 조건을 만족하는 메모 중 가장 오래된 날짜를 반환한다', () => {
    const oldest = daysAgo(30)
    const r = parent({
      memos: [
        { memo: 'a', date: daysAgo(5), category: '네트워크·앱 오류 > 와이파이 오류' },
        { memo: 'b', date: oldest, category: '네트워크·앱 오류 > 앱 오류' },
        { memo: 'c', date: daysAgo(15), category: '기기·하드웨어 오류 > 충전 불량' },
      ],
    })
    expect(getFirstDate(r)).toBe(oldest)
  })

  it('메모가 없으면 null을 반환한다', () => {
    const r = parent({ memos: [] })
    expect(getFirstDate(r)).toBeNull()
  })

  it('90일보다 오래된 메모는 최초 상담일 계산에서도 제외된다', () => {
    const recent = daysAgo(10)
    const r = parent({
      memos: [
        { memo: 'old', date: daysAgo(200), category: '네트워크·앱 오류 > 와이파이 오류' },
        { memo: 'recent', date: recent, category: '네트워크·앱 오류 > 앱 오류' },
      ],
    })
    expect(getFirstDate(r)).toBe(recent)
  })
})

describe('compareRows', () => {
  const noFilter = { main: null, sub: null }
  const a = parent({
    parent_id: 'A', memos: [
      { memo: 'a', date: daysAgo(30), category: '네트워크·앱 오류 > 와이파이 오류' },
      { memo: 'b', date: daysAgo(20), category: '네트워크·앱 오류 > 앱 오류' },
      { memo: 'c', date: daysAgo(10), category: '기기·하드웨어 오류 > 충전 불량' },
    ],
  })
  const b = parent({
    parent_id: 'B', memos: [
      { memo: 'a', date: daysAgo(25), category: '네트워크·앱 오류 > 와이파이 오류' },
      { memo: 'b', date: daysAgo(15), category: '네트워크·앱 오류 > 앱 오류' },
      { memo: 'c', date: daysAgo(8), category: '기기·하드웨어 오류 > 충전 불량' },
      { memo: 'd', date: daysAgo(5), category: '기기·하드웨어 오류 > 분실, 파손' },
    ],
  })

  it('상담 건수 내림차순 정렬', () => {
    expect(compareRows(a, b, 'cs_count', 'desc', noFilter)).toBeGreaterThan(0)
  })

  it('상담 건수 오름차순 정렬', () => {
    expect(compareRows(a, b, 'cs_count', 'asc', noFilter)).toBeLessThan(0)
  })

  it('마지막 상담일 내림차순 정렬', () => {
    expect(compareRows(a, b, 'latest_date', 'desc', noFilter)).toBeGreaterThan(0)
  })
})

describe('getDisplayCount', () => {
  const r = parent({
    memos: [
      { memo: 'a', date: daysAgo(30), category: '네트워크·앱 오류 > 와이파이 오류' },
      { memo: 'b', date: daysAgo(20), category: '네트워크·앱 오류 > 앱 오류' },
      { memo: 'c', date: daysAgo(10), category: '기기·하드웨어 오류 > 충전 불량' },
    ],
  })

  it('필터가 없으면 전체 자격 메모 수를 반환한다', () => {
    expect(getDisplayCount(r, { main: null, sub: null })).toBe(3)
  })

  it('대분류 필터가 있으면 그 대분류에 속한 메모 수만 반환한다', () => {
    expect(getDisplayCount(r, { main: '네트워크·앱 오류', sub: null })).toBe(2)
  })
})

describe('rowsForCategory', () => {
  const withCategory = parent({
    parent_id: 'A', memos: [
      { memo: '최신', date: daysAgo(5), category: '기기·하드웨어 오류 > 충전·전원 불량' },
      { memo: '이전', date: daysAgo(20), category: '기기·하드웨어 오류 > 충전·전원 불량' },
      { memo: '무관', date: daysAgo(10), category: '기기·하드웨어 오류 > 분실, 파손' },
    ],
  })
  const withoutCategory = parent({
    parent_id: 'B', memos: [
      { memo: 'x', date: daysAgo(10), category: '네트워크·앱 오류 > 와이파이 오류' },
    ],
  })

  it('해당 소분류 메모가 있는 학부모만 포함한다', () => {
    const rows = rowsForCategory([withCategory, withoutCategory], '기기·하드웨어 오류 > 충전·전원 불량')
    expect(rows.map(r => r.parent_id)).toEqual(['A'])
  })

  it('같은 대분류라도 소분류가 다르면 포함하지 않는다', () => {
    const rows = rowsForCategory([withCategory], '기기·하드웨어 오류 > 분실, 파손')
    expect(rows[0]).toMatchObject({ count: 1, latestMemo: '무관' })
  })

  it('해당 소분류 메모 건수와 가장 최근 메모를 담는다', () => {
    const rows = rowsForCategory([withCategory], '기기·하드웨어 오류 > 충전·전원 불량')
    expect(rows[0]).toMatchObject({ count: 2, latestMemo: '최신' })
  })
})
