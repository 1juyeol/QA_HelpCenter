// categories.ts 유닛 테스트.
// isAllowed: main/sub 분리 형태의 허용 여부 판정 검증.
// isAllowedCategory: "대분류 > 소분류" 합산 문자열 형태의 허용 여부 판정 검증.
// ALLOWED 기준이 바뀔 때 의도치 않은 포함·제외가 생기는지 잡는 것이 목적.
import { describe, it, expect } from 'vitest'
import { isAllowed, isAllowedCategory } from './categories'

describe('isAllowed', () => {
  it('ALLOWED_MAIN 대분류는 소분류 무관하게 허용', () => {
    expect(isAllowed('네트워크·앱 오류', '와이파이 오류')).toBe(true)
    expect(isAllowed('기기·하드웨어 오류', '기기 교체 요청')).toBe(true)
    expect(isAllowed('기기·하드웨어 오류', null)).toBe(true)
  })

  it('ALLOWED_SPECIFIC 소분류만 허용', () => {
    expect(isAllowed('미납·결제', '미납 관리')).toBe(true)
    expect(isAllowed('해지·유지 상담', '해지 확정')).toBe(true)
    expect(isAllowed('해지·유지 상담', '해지금·위약금 문의')).toBe(true)
    expect(isAllowed('교재·물류·배송', '기기 장기미회수')).toBe(true)
    expect(isAllowed('교재·물류·배송', '누락·오배송')).toBe(true)
  })

  it('제거된 결제·환불 처리는 불허', () => {
    expect(isAllowed('미납·결제', '결제·환불 처리')).toBe(false)
  })

  it('허용되지 않은 대분류는 불허', () => {
    expect(isAllowed('기타', '기타')).toBe(false)
    expect(isAllowed('체험 관련', null)).toBe(false)
    expect(isAllowed('계정·서비스', '계정 오류')).toBe(false)
  })

  it('main이 null이면 불허', () => {
    expect(isAllowed(null, null)).toBe(false)
    expect(isAllowed(null, '미납 관리')).toBe(false)
  })
})

describe('isAllowedCategory', () => {
  it('"대분류 > 소분류" 합산 문자열 허용', () => {
    expect(isAllowedCategory('네트워크·앱 오류 > 앱 오류')).toBe(true)
    expect(isAllowedCategory('미납·결제 > 미납 관리')).toBe(true)
  })

  it('"대분류 > 소분류" 합산 문자열 불허', () => {
    expect(isAllowedCategory('미납·결제 > 결제·환불 처리')).toBe(false)
    expect(isAllowedCategory('기타 > 기타')).toBe(false)
  })

  it('소분류 없는 대분류 문자열', () => {
    expect(isAllowedCategory('네트워크·앱 오류')).toBe(true)
    expect(isAllowedCategory('미납·결제')).toBe(false)
  })
})
