// 관리자 전용 로드맵 페이지. 두 종류를 묶어 보여준다:
//   1) 배포 준비 작업 — Docker·Firebase·HTTPS·CS 수집 API 활성화 등 인프라 마이그레이션 작업
//   2) 인사이트 로드맵 — 학습 데이터 연동을 전제로 논의됐던 인사이트 후보들
// 둘 다 실시간 데이터가 아니라 이 파일 안의 정적 목록이며, API 호출 없이 상수만 렌더링한다.
// CS 수집 API 관련 모니터링(호출 규칙·횟수·상세 로그)은 pages/admin/ApiConsole.tsx로 분리했다
// (이 페이지 하나에 다 몰아넣었더니 너무 길어져서 나눔).
//
// 접근 제어: useAdmin()의 isAdmin이 false면 본문 대신 잠금 안내만 보여준다.
// 이 페이지 자체는 민감한 고객 데이터를 담지 않으므로(할 일·아이디어 목록일 뿐) 백엔드 API 보호는 두지 않았다.
import { useAdmin } from '../../hooks/useAdmin'

type Status = 'done' | 'blocked' | 'pending' | 'todo'

interface Candidate {
  title: string
  note?: string
  status: Status
}

const STATUS_LABEL: Record<Status, string> = {
  done: '구현됨',
  blocked: '학습 데이터 필요',
  pending: '외부 요인 대기',
  todo: '미착수',
}

const STATUS_COLOR: Record<Status, string> = {
  done: '#16a34a',
  blocked: '#ef4444',
  pending: '#f59e0b',
  todo: '#94a3b8',
}

const INFRA_TASKS: { title: string; candidates: Candidate[] }[] = [
  {
    title: 'Docker 배포 (서버컴)',
    candidates: [
      { title: 'backend/Dockerfile 작성', status: 'todo' },
      { title: 'docker-compose.yml 작성', note: '백엔드 서비스 + Watchtower(자동 배포 감시)', status: 'todo' },
      { title: 'Docker Hub 계정 확인/생성', note: '이미지 올릴 레지스트리', status: 'todo' },
      { title: '파트리더 컨테이너와 포트 충돌 확인', note: '같은 서버컴에 이미 Docker 사용 중', status: 'todo' },
      { title: '로컬(개발) 컴퓨터에 Docker Desktop 설치', status: 'todo' },
    ],
  },
  {
    title: 'Firebase 배포 (프론트)',
    candidates: [
      {
        title: 'Firebase 프로젝트 생성 및 배포',
        note: '백엔드 주소가 안정화된 뒤 진행 — 지금 하면 나중에 다시 해야 함',
        status: 'todo',
      },
      {
        title: 'VITE_API_BASE_URL 설정 후 재빌드',
        note: 'frontend/api/client.ts는 이미 이 환경변수를 읽도록 준비돼 있음 (프론트/백엔드 절대경로 참고)',
        status: 'todo',
      },
    ],
  },
  {
    title: '백엔드 HTTPS',
    candidates: [
      {
        title: 'HTTPS 인증서 방식 결정',
        note: 'Cloudflare Tunnel(추천) / 회사 도메인+Let\'s Encrypt / 자체서명 중 선택 필요',
        status: 'pending',
      },
    ],
  },
  {
    title: 'CS 상담 수집 API 활성화',
    candidates: [
      {
        title: '관리자 모드에서 CS 수집 토글 켜기',
        note: '회사 승인 완료(2026-08), 실제로 켜서 확인 완료. 상세 규칙/모니터링은 "API 관리" 메뉴 참고',
        status: 'done',
      },
    ],
  },
]

const AXES: { title: string; candidates: Candidate[] }[] = [
  {
    title: '1. 학습 데이터 × CS',
    candidates: [
      { title: '학습 공백 → CS 선행 지표', note: '학습 3일 공백 후 CS 발생 확률 N배', status: 'blocked' },
      { title: '기술 오류가 학습에 미치는 손실', note: '앱오류 CS 후 평균 학습 공백 일수 (개발팀 압박용)', status: 'blocked' },
      { title: 'CS 해결 후 학습 복귀율', note: '카테고리별·A/S 처리 기간별 비교', status: 'blocked' },
      { title: '학습 공백 ↔ CS 인과 방향 분석', note: 'CS 전후 7일 학습시간 대칭 비교', status: 'blocked' },
      { title: '학습 사용량 × 기기 오류', note: '집중 학습자 vs 가벼운 학습자 오류 CS 비율 차이', status: 'blocked' },
    ],
  },
  {
    title: '2. A/S × CS × 학습',
    candidates: [
      { title: '기기교체 완료 후 학습 재개 기간', note: '처리 속도 = 학습 연속성 = LTV 체인', status: 'blocked' },
      { title: 'A/S 완료 후 학습 미복귀 탐지', note: '완료 후 3일 내 미재개 시 retention 연락 트리거', status: 'blocked' },
    ],
  },
  {
    title: '3. 고객 정보 × CS',
    candidates: [
      { title: '학습 성취율 → 해지 방어', note: '진도 50% 이상 = 해지율 절반 (본부장 보고 최강)', status: 'blocked' },
      { title: 'CS 없이 해지한 고객', note: '학습 참여도 0 상태 지속 → CS로도 못 잡는 침묵 이탈', status: 'blocked' },
      { title: '"포기한 구독자" 탐지', note: '학습 하위 20% + CS 없음 + 미해지. 아무도 모르는 상태', status: 'blocked' },
      { title: '"왜 아직 있나" 역분석', note: '비슷한 CS+학습공백인데 해지 안 한 고객 특징 → 이탈 방어 요인', status: 'blocked' },
      { title: 'CS 없는 해지 고객 선행 학습 패턴', note: '3개월 연속 학습 감소 = 침묵 이탈 신호', status: 'blocked' },
      { title: '가입 경로·지역·플랜 × CS', note: '학습 데이터 없이도 가능, 아직 설계 전', status: 'todo' },
    ],
  },
  {
    title: '4. 결제 × CS',
    candidates: [
      { title: '미납·환불·리뉴얼 이력 × CS', note: '학습 데이터 없이도 가능, 아직 설계 전', status: 'todo' },
    ],
  },
  {
    title: 'QA 연계 (학습 데이터 불필요)',
    candidates: [
      { title: '수주째 반복 CS = 미패치 버그 목록', note: '카테고리 × 주차 매트릭스, 스프린트 요청 근거', status: 'done' },
    ],
  },
]

function StatusBadge({ status }: { status: Status }) {
  return (
    <span
      style={{
        fontSize: 11, fontWeight: 700, color: '#fff',
        background: STATUS_COLOR[status], borderRadius: 4,
        padding: '2px 8px', whiteSpace: 'nowrap',
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  )
}

export default function InsightRoadmap() {
  const { isAdmin } = useAdmin()

  if (!isAdmin) {
    return (
      <div className="section-card">
        <h2>🔒 관리자 전용 페이지</h2>
        <p style={{ color: '#64748b', fontSize: 13 }}>
          사이드바 하단의 잠금 아이콘에서 관리자 암호를 입력해야 볼 수 있습니다.
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="section-card">
        <h2>배포 준비 작업</h2>
        <p style={{ color: '#64748b', fontSize: 13, marginTop: -8, marginBottom: 4 }}>
          프론트(Firebase) · 백엔드(서버컴 Docker) 분리 배포를 위해 언젠가 처리해야 할 작업.
        </p>
      </div>

      {INFRA_TASKS.map(group => (
        <div className="section-card" key={group.title}>
          <h2>{group.title}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {group.candidates.map(c => (
              <div
                key={c.title}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                  gap: 12, padding: '10px 12px', background: '#f8fafc', borderRadius: 8,
                }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{c.title}</div>
                  {c.note && (
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{c.note}</div>
                  )}
                </div>
                <StatusBadge status={c.status} />
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="section-card">
        <h2>인사이트 로드맵</h2>
        <p style={{ color: '#64748b', fontSize: 13, marginTop: -8, marginBottom: 4 }}>
          학습 데이터 연동을 전제로 논의된 인사이트 후보 목록. help-desk 상담 API만으로는
          "학습 데이터 필요" 상태 항목을 만들 수 없다.
        </p>
      </div>

      {AXES.map(axis => (
        <div className="section-card" key={axis.title}>
          <h2>{axis.title}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {axis.candidates.map(c => (
              <div
                key={c.title}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                  gap: 12, padding: '10px 12px', background: '#f8fafc', borderRadius: 8,
                }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{c.title}</div>
                  {c.note && (
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{c.note}</div>
                  )}
                </div>
                <StatusBadge status={c.status} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
