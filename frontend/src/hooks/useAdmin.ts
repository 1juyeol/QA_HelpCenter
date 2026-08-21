// 관리자 모드 상태를 관리하는 훅. 계정 로그인 없이 "관리자 암호를 아는지"만 확인한다.
// 통과하면 백엔드가 발급한 무작위 세션 토큰을 localStorage에 저장한다 — 암호(ADMIN_PASSCODE)
// 자체는 브라우저에 남기지 않는다. 관리자 전용 API(예: CS 수집 on/off)를 호출할 때
// adminToken을 X-Admin-Token 헤더로 실어 보낸다. 토큰은 서버 재시작 시 무효화되므로
// 그 이후엔 isAdmin이 true로 보여도 실제 API 호출은 403이 날 수 있다(재인증 필요).
//
// 사용처: Sidebar.tsx(잠금 아이콘·암호 입력·CS 수집 토글), 관리자 전용 페이지(pages/admin/*)에서
// isAdmin으로 화면 가림.
//
// 나중에 실제 ID/PW 로그인으로 바꿀 때는 이 훅 내부(verify 구현)만 교체하면 되고,
// 이 훅을 쓰는 컴포넌트들은 수정할 필요가 없다.
import { useState, useCallback } from 'react'
import { api } from '../api/client'

const STORAGE_KEY = 'cs_admin_token'

export function useAdmin() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY))

  const verify = useCallback(async (passcode: string) => {
    const result = await api.verifyAdmin(passcode)
    if (result.ok && result.token) {
      localStorage.setItem(STORAGE_KEY, result.token)
      setToken(result.token)
    }
    return result.ok
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY)
    setToken(null)
  }, [])

  return { isAdmin: !!token, adminToken: token, verify, logout }
}
