// 관리자 모드 상태를 앱 전역에서 공유하는 Context. 계정 로그인 없이 "관리자 암호를 아는지"만
// 확인한다. 통과하면 백엔드가 발급한 무작위 세션 토큰을 localStorage에 저장한다 — 암호
// (ADMIN_PASSCODE) 자체는 브라우저에 남기지 않는다. 관리자 전용 API(예: CS 수집 on/off)를
// 호출할 때 adminToken을 X-Admin-Token 헤더로 실어 보낸다. 토큰은 서버 재시작 시 무효화되므로
// 그 이후엔 isAdmin이 true로 보여도 실제 API 호출은 403이 날 수 있다(재인증 필요).
//
// Context로 만든 이유: 예전엔 컴포넌트마다 이 훅을 각자 호출해서(local useState) 로그인 상태가
// 컴포넌트별로 따로 놀았다 — 사이드바에서 로그인해도 이미 열려 있던 다른 관리자 페이지는
// 새로고침해야만 반영됐음(그 페이지가 마운트될 때 localStorage를 한 번만 읽었기 때문).
// Provider 하나로 상태를 공유해서 로그인하는 즉시 모든 화면에 반영되게 한다.
//
// 사용처: Sidebar.tsx(잠금 아이콘·암호 입력·CS 수집 토글), 관리자 전용 페이지(pages/admin/*)에서
// isAdmin으로 화면 가림.
//
// 나중에 실제 ID/PW 로그인으로 바꿀 때는 AdminProvider 내부(verify 구현)만 교체하면 되고,
// useAdmin()을 쓰는 컴포넌트들은 수정할 필요가 없다.
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { api } from '../api/client'

const STORAGE_KEY = 'cs_admin_token'

interface AdminContextValue {
  isAdmin: boolean
  adminToken: string | null
  verify: (passcode: string) => Promise<boolean>
  logout: () => void
}

const AdminContext = createContext<AdminContextValue | null>(null)

export function AdminProvider({ children }: { children: ReactNode }) {
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

  const value: AdminContextValue = { isAdmin: !!token, adminToken: token, verify, logout }
  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>
}

export function useAdmin() {
  const ctx = useContext(AdminContext)
  if (!ctx) throw new Error('useAdmin()은 AdminProvider 안에서만 사용할 수 있습니다')
  return ctx
}
