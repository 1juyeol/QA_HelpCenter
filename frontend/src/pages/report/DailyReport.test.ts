// DailyReport.tsx의 findTopCategoryHighlightRange() 유닛 테스트.
// Gemma 요약 문장 안에서 "1위 카테고리 이름+건수(+비율)" 부분의 시작·끝 위치를 찾는 순수 함수.
// 못 찾으면 null을 반환해 화면에서 강조 없이 원문 그대로 보여주게 한다.
import { describe, it, expect } from 'vitest'
import { findTopCategoryHighlightRange } from './DailyReport'

describe('findTopCategoryHighlightRange', () => {
  it('이름+건수+비율이 그대로 붙어 있으면 그 구간 전체를 찾는다', () => {
    const text = '충전·전원 불량이 48건(22.5%)으로 가장 많고, 터치·입력 불량 16건(7.5%)이 뒤를 잇습니다.'
    const top = { name: '충전·전원 불량', count: 48, pct: 22.5 }
    const range = findTopCategoryHighlightRange(text, top)
    expect(range).not.toBeNull()
    const [start, end] = range!
    expect(text.slice(start, end)).toBe('충전·전원 불량이 48건(22.5%)')
  })

  it('비율(%) 없이 이름+건수만 있어도 찾는다', () => {
    const text = '네트워크 연결 불안정이 6건으로 나타났습니다.'
    const top = { name: '네트워크 연결 불안정', count: 6, pct: 100 }
    const range = findTopCategoryHighlightRange(text, top)
    expect(range).not.toBeNull()
    const [start, end] = range!
    expect(text.slice(start, end)).toBe('네트워크 연결 불안정이 6건')
  })

  it('이름은 있는데 해당 건수가 근처에 없으면 null', () => {
    const text = '충전·전원 불량 관련 문의가 접수되었습니다.'
    const top = { name: '충전·전원 불량', count: 48, pct: 22.5 }
    expect(findTopCategoryHighlightRange(text, top)).toBeNull()
  })

  it('이름 자체가 요약에 없으면 null', () => {
    const text = '터치·입력 불량이 16건으로 가장 많습니다.'
    const top = { name: '충전·전원 불량', count: 48, pct: 22.5 }
    expect(findTopCategoryHighlightRange(text, top)).toBeNull()
  })

  it('이름에 정규식 특수문자가 있어도 안전하게 처리한다', () => {
    const text = '기기(전원) 불량이 10건 발생했습니다.'
    const top = { name: '기기(전원) 불량', count: 10, pct: 50 }
    const range = findTopCategoryHighlightRange(text, top)
    expect(range).not.toBeNull()
    const [start, end] = range!
    expect(text.slice(start, end)).toBe('기기(전원) 불량이 10건')
  })

  it('이름과 건수 사이가 20자를 넘게 떨어져 있으면 null', () => {
    const text = '충전·전원 불량은 이 시간대 여러 상담원이 동시에 접수를 처리하는 과정에서 48건 확인되었습니다.'
    const top = { name: '충전·전원 불량', count: 48, pct: 22.5 }
    expect(findTopCategoryHighlightRange(text, top)).toBeNull()
  })

  it('건수 없이 비율만 있어도 찾는다 (실제로 Gemma가 이렇게 쓴 사례)', () => {
    const text = '기타 27.7%, 해지·유지 상담 24.6%, 미납·결제 23.1% 등 여러 카테고리가 고르게 접수되었습니다.'
    const top = { name: '기타', count: 18, pct: 27.7 }
    const range = findTopCategoryHighlightRange(text, top)
    expect(range).not.toBeNull()
    const [start, end] = range!
    expect(text.slice(start, end)).toBe('기타 27.7%')
  })
})
