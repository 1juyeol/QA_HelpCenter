// CS 카테고리 허용 기준과 필터 트리를 한 곳에서 관리한다.
// ALLOWED_MAIN·ALLOWED_SPECIFIC·FILTER_TREE·isAllowed·isAllowedCategory를 export하며,
// 이 기준을 참조하는 모든 컴포넌트(RepeatParents, InsightsSummary 등)는 여기서만 import한다.
// ALLOWED 기준이 바뀌면 이 파일만 수정하면 된다.
//
// ALLOWED_MAIN  : 해당 대분류의 모든 소분류를 허용 (네트워크·앱 오류, 기기·하드웨어 오류)
// ALLOWED_SPECIFIC : 소분류 단위 허용 (결제·환불 처리는 카드 변경 행정이 대부분이라 제외)
// FILTER_TREE   : 필터 버튼 UI에 노출할 대분류·소분류 목록. ALLOWED 범위와 일치해야 한다.

export const ALLOWED_MAIN = new Set(['네트워크·앱 오류', '기기·하드웨어 오류'])

export const ALLOWED_SPECIFIC = new Set([
  '미납·결제 > 미납 관리',
  '해지·유지 상담 > 해지 확정',
  '해지·유지 상담 > 해지금·위약금 문의',
  '교재·물류·배송 > 기기 장기미회수',
  '교재·물류·배송 > 누락·오배송',
])

export const FILTER_TREE = [
  { main: '네트워크·앱 오류',   subs: ['와이파이 오류', '학습 끊김·멈춤', '앱 오류'] },
  { main: '기기·하드웨어 오류', subs: ['충전 불량', '터치·화면 불량', '전원·부팅 오류', '기기 파손', '기기 교체 요청'] },
  { main: '미납·결제',          subs: ['미납 관리'] },
  { main: '해지·유지 상담',     subs: ['해지 확정', '해지금·위약금 문의'] },
  { main: '교재·물류·배송',     subs: ['기기 장기미회수', '누락·오배송'] },
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
