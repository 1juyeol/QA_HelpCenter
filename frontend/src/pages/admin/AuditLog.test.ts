// AuditLog.tsx의 getReportLink()/parseDetail()/formatField()/translateMailError() 유닛 테스트.
// getReportLink: 감사 로그의 보고서 관련 action+detail에서 해당 보고서 화면 링크를 정확히 뽑아내는지 검증.
// parseDetail/formatField: "date=2026-08-19, main=X, status=success" 같은 key=value 나열을
// renderDetail()이 사람이 읽는 문장으로 바꿀 때 쓰는 파싱·변환 단계가 올바른지 검증.
// translateMailError: mail_client.py가 그대로 넘기는 영어 smtplib 예외 원문을 한국어 문장으로
// 바꾸는 함수 — 메일링 관리 페이지의 발신 이력도 AuditLogRow를 그대로 재사용하므로 여기서만 검증한다.
import { describe, it, expect } from 'vitest'
import { getReportLink, parseDetail, formatField, translateMailError } from './AuditLog'

describe('getReportLink', () => {
  it('일별 카테고리 분석은 date+highlight(카테고리명)를 담은 링크를 만든다', () => {
    expect(getReportLink('daily_report_analyze_category', 'date=2026-08-19, main=기기·하드웨어 오류, status=failed'))
      .toBe('/report/daily?date=2026-08-19&highlight=' + encodeURIComponent('기기·하드웨어 오류'))
  })

  it('일별 피크타임 분석은 __peak__ highlight를 담은 링크를 만든다', () => {
    expect(getReportLink('daily_report_analyze_peak', 'date=2026-08-19, status=failed'))
      .toBe('/report/daily?date=2026-08-19&highlight=__peak__')
  })

  it('일별 이상시간대 분석은 __anomaly__ highlight를 담은 링크를 만든다', () => {
    expect(getReportLink('daily_report_analyze_anomaly', 'date=2026-08-19, status=failed'))
      .toBe('/report/daily?date=2026-08-19&highlight=__anomaly__')
  })

  it('일별 생성 완료 요약 로그는 highlight 없이 날짜만 링크한다', () => {
    expect(getReportLink('daily_report_generate_complete', 'date=2026-08-19, gemma_failed=기기·하드웨어 오류'))
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

  it('attempt=1/2 처럼 값 안에 등호가 없는 필드도 그대로 파싱한다', () => {
    expect(parseDetail('date=2026-08-19, attempt=1/2, status=success')).toEqual([
      ['date', '2026-08-19'],
      ['attempt', '1/2'],
      ['status', 'success'],
    ])
  })

  it('prompt 값은 줄바꿈·쉼표가 있어도 끝까지 통째로 하나의 필드로 유지한다', () => {
    expect(parseDetail('date=2026-08-19, status=success, elapsed=12.3, prompt=[SYSTEM]\n규칙: a, b\n\n[USER]\n메모')).toEqual([
      ['date', '2026-08-19'],
      ['status', 'success'],
      ['elapsed', '12.3'],
      ['prompt', '[SYSTEM]\n규칙: a, b\n\n[USER]\n메모'],
    ])
  })

  it('error와 prompt가 둘 다 있어도 각각 끝까지 올바르게 분리된다', () => {
    expect(parseDetail('date=2026-08-19, status=failed, elapsed=1.0, error=실패, 사유 있음, prompt=전문, 내용')).toEqual([
      ['date', '2026-08-19'],
      ['status', 'failed'],
      ['elapsed', '1.0'],
      ['error', '실패, 사유 있음'],
      ['prompt', '전문, 내용'],
    ])
  })
})

describe('formatField', () => {
  it('date는 "보고서 날짜"를 붙여서 보여준다', () => {
    expect(formatField('date', '2026-08-19')).toBe('보고서 날짜: 2026-08-19')
  })

  it('week_start는 "주"를 붙인다', () => {
    expect(formatField('week_start', '2026-08-10')).toBe('2026-08-10 주')
  })

  it('gemma_failed는 "실패 항목: "을 붙인다', () => {
    expect(formatField('gemma_failed', '기기·하드웨어 오류')).toBe('실패 항목: 기기·하드웨어 오류')
  })

  it('attempt는 "N회차"로 바꾼다', () => {
    expect(formatField('attempt', '1/2')).toBe('재시도 1/2회차')
  })

  it('resolved는 "재시도로 해결됨: "을 붙인다', () => {
    expect(formatField('resolved', '기기·하드웨어 오류')).toBe('재시도로 해결됨: 기기·하드웨어 오류')
  })

  it('알 수 없는 키는 null을 반환해 조용히 생략된다', () => {
    expect(formatField('unknown_key', 'x')).toBeNull()
  })

  it('elapsed는 "N초 소요"로 바꾼다', () => {
    expect(formatField('elapsed', '12.3')).toBe('12.3초 소요')
  })

  it('reason은 알려진 사유면 전체 문장으로, "사유: " 접두사와 함께 바꾼다', () => {
    expect(formatField('reason', '보고서 없음')).toBe('사유: 대상 날짜의 보고서가 아직 만들어지지 않아 발송하지 않았습니다.')
  })

  it('reason이 알려지지 않은 값이면 "사유: " 접두사만 붙이고 원문을 그대로 둔다', () => {
    expect(formatField('reason', '새로운 사유')).toBe('사유: 새로운 사유')
  })

  it('prompt_key는 어떤 프롬프트인지 보여준다', () => {
    expect(formatField('prompt_key', 'daily_category')).toBe('프롬프트: daily_category')
  })

  it('report_type은 어떤 설정 대상인지 보여준다', () => {
    expect(formatField('report_type', 'wings_refresh')).toBe('대상: wings_refresh')
  })

  it('enabled는 켜짐/꺼짐 문장으로 바꾼다', () => {
    expect(formatField('enabled', 'True')).toBe('자동 실행 켜짐')
    expect(formatField('enabled', 'False')).toBe('자동 실행 꺼짐')
  })

  it('hour/minute은 설정 시각 문장으로 바꾼다', () => {
    expect(formatField('hour', '9')).toBe('9시로 설정')
    expect(formatField('minute', '30')).toBe('30분으로 설정')
  })
})

describe('translateMailError', () => {
  it('타임아웃 에러를 한국어로 바꾼다', () => {
    const result = translateMailError('TimeoutError: timed out')
    expect(result).toContain('시간 초과')
    expect(result).toContain('VPN')
  })

  it('SMTP 인증 실패(535)를 한국어로 바꾼다', () => {
    const result = translateMailError("(535, b'5.7.8 Error: authentication failed: UGFzc3dvcmQ6')")
    expect(result).toContain('인증에 실패')
  })

  it('연결 거부 에러를 한국어로 바꾼다', () => {
    const result = translateMailError('Connection refused')
    expect(result).toContain('연결을 거부')
  })

  it('알 수 없는 에러는 원문을 그대로 보여준다', () => {
    expect(translateMailError('이상한 에러 메시지')).toBe('이상한 에러 메시지')
  })
})
