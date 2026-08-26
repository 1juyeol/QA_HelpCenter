// 재사용 가능한 밑줄형 탭 컴포넌트.
// 예전엔 탭마다 독립된 알약 버튼을 나열해서 아래 콘텐츠와 시각적으로 아무 관계가 없어 보였다
// (그냥 버튼 그룹처럼 보임). 이 컴포넌트는 탭 줄 전체에 얇은 하단 테두리를 깔고 활성 탭에만
// 그 위로 굵은 색상 밑줄을 얹어서, "지금 선택된 탭이 바로 아래 콘텐츠로 이어진다"는 느낌을 준다.
//
// 사용법:
//   <Tabs items={[{ key: 'daily', label: '일별 보고서' }, { key: 'weekly', label: '주간 보고서' }]}
//         active={tab} onChange={setTab} />
export interface TabItem {
  key: string
  label: string
}

export default function Tabs({
  items, active, onChange,
}: {
  items: readonly TabItem[]
  active: string
  onChange: (key: string) => void
}) {
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e2e8f0', marginBottom: 20 }}>
      {items.map(item => {
        const isActive = item.key === active
        return (
          <button
            key={item.key}
            onClick={() => onChange(item.key)}
            style={{
              padding: '10px 20px', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 16, fontWeight: 700,
              color: isActive ? '#1e3c72' : '#64748b',
              borderBottom: isActive ? '3px solid #1e3c72' : '3px solid transparent',
              marginBottom: -2,
            }}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
