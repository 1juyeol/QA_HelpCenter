// 관리자 전용 "자동화 관리" 페이지. 예전에 따로 있던 API 관리·메일링 관리 페이지와, 화면
// 없이 코드에 하드코딩되어 있던 보고서 자동 생성 스케줄(00:30)을 탭 9개짜리 화면 하나로
// 통합한다 — CS 수집 API 호출, 보고서 생성, 보고서 메일 발송, 인사이트 캐시 자동 갱신,
// Gemma 프롬프트 편집까지 이 서비스의 "자동으로 도는 것들"을 전부 한 곳에서 확인·설정할
// 수 있게 하기 위함이다.
//
// 탭 구성: API 관리 / 일별 보고서 생성 / 주간 보고서 생성 / 일별 보고서 발송 / 주간 보고서 발송 /
// 반복 Wings 티켓 갱신 / 학부모 반복 인입 갱신 / 일간보고서 프롬프트 / 주간보고서 프롬프트.
// API 관리는 기존 ApiConsole 컴포넌트를 그대로 재사용(수정 없음). 생성·발송 탭은 각각
// GenerationSettingsSection/MailSettingsSection을 report_type만 바꿔 재사용하고, 인사이트
// 갱신 두 탭은 InsightRefreshSettingsSection을 jobType만 바꿔, 프롬프트 두 탭은
// PromptSettingsSection을 reportType만 바꿔 재사용한다(기존 생성/발송 탭과 같은 "설정 하나 =
// 탭 하나" 구조를 그대로 따른다) — 실제 설정 UI·로직은 그 파일들이 담당하고, 이 페이지는
// 탭 전환과 접근 제어(관리자 전용)만 맡는다.
import { useState } from 'react'
import { useAdmin } from '../../hooks/useAdmin'
import Tabs from '../../components/Tabs'
import ApiConsole from './ApiConsole'
import { GenerationSettingsSection } from './GenerationSettings'
import { MailSettingsSection } from './MailingSettings'
import { InsightRefreshSettingsSection } from './InsightRefreshSettings'
import { PromptSettingsSection } from './PromptSettings'

const TABS = [
  { key: 'api', label: 'API 관리' },
  { key: 'daily-generate', label: '일별 보고서 생성' },
  { key: 'weekly-generate', label: '주간 보고서 생성' },
  { key: 'daily-send', label: '일별 보고서 발송' },
  { key: 'weekly-send', label: '주간 보고서 발송' },
  { key: 'wings-refresh', label: '반복 Wings 티켓 갱신' },
  { key: 'repeat-parents-refresh', label: '학부모 반복 인입 갱신' },
  { key: 'daily-prompt', label: '일간보고서 프롬프트' },
  { key: 'weekly-prompt', label: '주간보고서 프롬프트' },
] as const

type TabKey = typeof TABS[number]['key']

export default function AutomationManagement() {
  const { isAdmin } = useAdmin()
  const [tab, setTab] = useState<TabKey>('api')

  if (!isAdmin) {
    return (
      <div className="section-card">
        <h2>🔒 관리자 전용 페이지</h2>
        <p style={{ color: '#334155', fontSize: 15 }}>
          사이드바 하단의 잠금 아이콘에서 관리자 암호를 입력해야 볼 수 있습니다.
        </p>
      </div>
    )
  }

  return (
    <div>
      <Tabs items={TABS} active={tab} onChange={key => setTab(key as TabKey)} />
      {tab === 'api' && <ApiConsole />}
      {tab === 'daily-generate' && <GenerationSettingsSection reportType="daily" />}
      {tab === 'weekly-generate' && <GenerationSettingsSection reportType="weekly" />}
      {tab === 'daily-send' && <MailSettingsSection reportType="daily" />}
      {tab === 'weekly-send' && <MailSettingsSection reportType="weekly" />}
      {tab === 'wings-refresh' && <InsightRefreshSettingsSection jobType="wings_refresh" />}
      {tab === 'repeat-parents-refresh' && <InsightRefreshSettingsSection jobType="repeat_parents_refresh" />}
      {tab === 'daily-prompt' && <PromptSettingsSection reportType="daily" />}
      {tab === 'weekly-prompt' && <PromptSettingsSection reportType="weekly" />}
    </div>
  )
}
