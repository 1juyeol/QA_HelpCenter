// 상담 카테고리 허용 기준과 필터 트리를 한 곳에서 관리한다.
// ALLOWED_MAIN·ALLOWED_SPECIFIC·isAllowed·isAllowedCategory는 "기술적 결함 리스크"만 좁게
// 보는 기준이고(SQI/ServiceQualityIndex·StrategicDashboard가 리스크 비율 계산에 씀,
// backend/features/report/report_utils.py의 RISK_MAIN/RISK_SPECIFIC과 대응), FILTER_TREE는
// 이것과 더 이상 범위가 같지 않다 — "학부모 반복 상담"(RepeatParents)은 리스크 여부와 무관하게
// 상담 자체의 빈도·패턴이 목적이라 "기타"까지 포함한 전체 대분류를 쓴다. 즉 FILTER_TREE는
// RepeatParents 전용이고 ALLOWED_MAIN/SPECIFIC보다 범위가 넓다 — 더 이상 서로 일치시킬
// 필요가 없다.
//
// ALLOWED_MAIN  : 대분류 전체가 리스크 (네트워크·앱 오류, 기기·하드웨어 오류)
// ALLOWED_SPECIFIC : 소분류 단위로만 리스크 (결제·환불 처리는 카드 변경 행정이 대부분이라 제외)
// FILTER_TREE   : 학부모 반복 상담 필터 버튼 UI에 노출할 전체 대분류·소분류 목록

export const ALLOWED_MAIN = new Set(['네트워크·앱 오류', '기기·하드웨어 오류'])

export const ALLOWED_SPECIFIC = new Set([
  '미납·결제 > 미납 관리',
  '해지·유지 상담 > 해지 확정',
  '해지·유지 상담 > 해지금·위약금 문의',
  '교재·물류·배송 > 기기 장기미회수',
  '교재·물류·배송 > 누락·오배송',
  '교재·물류·배송 > 기기 교체 요청',
])

export const FILTER_TREE = [
  { main: '네트워크·앱 오류',   subs: ['와이파이 오류', '학습 끊김·멈춤', '앱 오류'] },
  { main: '기기·하드웨어 오류', subs: ['충전·전원 불량', '터치·입력 불량', '분실, 파손'] },
  { main: '미납·결제',          subs: ['미납 관리'] },
  { main: '해지·유지 상담',     subs: ['해지 확정', '해지금·위약금 문의'] },
  { main: '교재·물류·배송',     subs: ['기기 장기미회수', '누락·오배송', '기기 교체 요청'] },
  { main: '체험 관련',         subs: ['체험 취소·미인지', '체험 신청·로그인 독려', '중복 신청'] },
  { main: '계정·서비스',       subs: ['개인정보 변경', '서비스·이벤트 문의'] },
  { main: '윙크북스',          subs: ['윙크북스', '구독취소'] },
  { main: '기타',              subs: ['기타', '교사 상담 요청'] },
]

// main·sub를 따로 받는 형태 — WeeklyCategoryRow처럼 분리된 필드에 사용
export function isAllowed(main: string | null, sub: string | null): boolean {
  if (!main) return false
  if (ALLOWED_MAIN.has(main)) return true
  return ALLOWED_SPECIFIC.has(sub ? `${main} > ${sub}` : main)
}

// "대분류 > 소분류" 합쳐진 문자열 형태 — memos[].category처럼 이미 합쳐진 값에 사용
export function isAllowedCategory(category: string): boolean {
  const [main, sub] = category.split(' > ')
  return isAllowed(main, sub ?? null)
}
