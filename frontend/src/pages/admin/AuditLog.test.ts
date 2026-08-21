// AuditLog.tsx의 getReportLink()/parseDetail()/formatField() 유닛 테스트.
// getReportLink: 감사 로그의 보고서 관련 action+detail에서 해당 보고서 화면 링크를 정확히 뽑아내는지 검증.
// parseDetail/formatField: "date=2026-08-19, main=X, status=success" 같은 key=value 나열을
// renderDetail()이 사람이 읽는 문장으로 바꿀 때 쓰는 파싱·변환 단계가 올바른지 검증.
import { describe, it, expect } from 'vitest'
import { getReportLink, parseDetail, formatField } from './AuditLog'

describe('getReportLink', () => {
  it('일별 카테고리 분석은 date+highlight(카테고리명)를 담은 링크를 만든다', () => {
    expect(getReportLink('daily_report_analyze_category', 'date=2026-08-19, main=기기·하드웨어 오류, status=failed'))
      .toBe('/report/daily?date=2026-08-19&highlight=' + encodeURIComponent('기기·하드웨어 오류'))
  })

  it('일별 피크타임 분석은 __peak__ highlight를 담은 링크를 만든다', () => {
    expect(getReportLink('daily_report_analyze_peak', 'date=2026-08-19, status=failed'))
      .toBe('/report/daily?date=2026-08-19&highlight=__peak__')
  })

  it('일별 자동/수동 생성 요약 로그는 highlight 없이 날짜만 링크한다', () => {
    expect(getReportLink('daily_report_auto_generate', 'date=2026-08-19, gemma_failed=기기·하드웨어 오류'))
      .toBe('/report/daily?date=2026-08-19')
  })

  it('주간 카테고리 분석은 week_start+highlight(카테고리명)를 담은 링크를 만든다', () => {
    expect(getReportLink('weekly_report_analyze_category', 'week_start=2026-08-10, main=미납·결제, status=failed'))
      .toBe('/report/weekly?week_start=2026-08-10&highlight=' + encodeURIComponent('미납·결제'))
  })

  it('주간 요약 분석은 __summary__ highlight를 담은 링크를 만든다', () => {
    expect(getReportLink('weekly_report_analyze_summary', 'week_start=2026-08-10, status=failed'))
      .toBe('/report/weekly?week_start=2026-08-10&highlight=__summary__')
  })

  it('날짜 정보가 없으면 null', () => {
    expect(getReportLink('daily_report_auto_generate', 'error=timeout')).toBeNull()
  })

  it('보고서 관련 액션이 아니면 null', () => {
    expect(getReportLink('admin_login', '')).toBeNull()
    expect(getReportLink('collection_toggle', 'enabled=True')).toBeNull()
  })
})

describe('parseDetail', () => {
  it('쉼표로 구분된 key=value를 쌍의 배열로 분해한다', () => {
    expect(parseDetail('date=2026-08-19, main=교재·물류·배송, status=success')).toEqual([
      ['date', '2026-08-19'],
      ['main', '교재·물류·배송'],
      ['status', 'success'],
    ])
  })

  it('error 값 안에 쉼표가 있어도 마지막 error 필드 하나로 통째로 유지한다', () => {
    expect(parseDetail('date=2026-08-19, status=failed, error=응답 없음 (0자: "")')).toEqual([
      ['date', '2026-08-19'],
      ['status', 'failed'],
      ['error', '응답 없음 (0자: "")'],
    ])
  })
})

describe('formatField', () => {
  it('date는 값 그대로 보여준다', () => {
    expect(formatField('date', '2026-08-19')).toBe('2026-08-19')
  })

  it('week_start는 "주"를 붙인다', () => {
    expect(formatField('week_start', '2026-08-10')).toBe('2026-08-10 주')
  })

  it('gemma_failed는 "실패 항목: "을 붙인다', () => {
    expect(formatField('gemma_failed', '기기·하드웨어 오류')).toBe('실패 항목: 기기·하드웨어 오류')
  })

  it('알 수 없는 키는 null을 반환해 조용히 생략된다', () => {
    expect(formatField('unknown_key', 'x')).toBeNull()
  })
})
