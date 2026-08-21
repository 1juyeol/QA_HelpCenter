// AuditLog.tsx의 getReportLink() 유닛 테스트.
// 감사 로그의 보고서 관련 action+detail에서 해당 보고서 화면 링크를 정확히 뽑아내는지 검증.
import { describe, it, expect } from 'vitest'
import { getReportLink } from './AuditLog'

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
