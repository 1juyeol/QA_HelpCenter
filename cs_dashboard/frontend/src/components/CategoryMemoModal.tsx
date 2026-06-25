// 대분류별 CS 메모 목록 모달 (공통 컴포넌트).
// 지정된 날짜 범위 내 대분류 메모를 소분류 체크박스 필터 + 50건씩 페이지네이션으로 보여준다.
// 위아래 양쪽에 페이지네이션 배치, 소분류 라벨은 기본 전체 선택.
// 재사용: 주간 보고서 도넛·라인 차트, 일별 보고서, 운영현황 등 어디서나 categoryMain + 날짜 범위만 넘기면 동작.
//
// Props:
//   categoryMain — 모달 제목이자 API 필터 기준 대분류명
//   dateStart / dateEnd — 초기 조회 날짜 범위 (YYYY-MM-DD). 점 클릭 시 단일 날짜 전달.
//   fullDateStart / fullDateEnd — 달력 선택 범위. 전달 시 모달 안에 주간 달력 표시.
//   onClose — 닫기 콜백
//
// 데이터 흐름:
//   GET /api/issues/subs?category_main=&start_date=&end_date=  → 소분류 체크박스 목록
//   GET /api/issues?category_main=&start_date=&end_date=&subs=&limit=50&offset=  → 메모 목록

import { useEffect, useState } from 'react'
import { api, type Issue } from '../api/client'

const PAGE_SIZE = 50

interface Props {
  categoryMain: string
  dateStart: string
  dateEnd: string
  onClose: () => void
  initialSubs?: string[]
  fullDateStart?: string
  fullDateEnd?: string
  allowedSubs?: string[]  // 지정 시 이 소분류만 체크박스에 표시
}

function fmtDate(dtStr: string): string {
  // "2026-06-25 14:30:00" 또는 "2026-06-25T14:30:00" → "2026-06-25 14:30"
  return dtStr.slice(0, 16).replace('T', ' ')
}


export default function CategoryMemoModal({ categoryMain, dateStart, dateEnd, onClose, initialSubs, fullDateStart, fullDateEnd, allowedSubs }: Props) {
  const [availableSubs, setAvailableSubs] = useState<string[]>([])
  const [checkedSubs, setCheckedSubs] = useState<string[]>([])
  const [page, setPage] = useState(1)
  const [memos, setMemos] = useState<Issue[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [curStart, setCurStart] = useState(dateStart)
  const [curEnd, setCurEnd] = useState(dateEnd)

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  useEffect(() => {
    api.fetchIssueSubs(categoryMain, curStart, curEnd)
      .then(res => {
        const subs = allowedSubs ? res.subs.filter(s => allowedSubs.includes(s)) : res.subs
        setAvailableSubs(subs)
        setCheckedSubs(initialSubs && initialSubs.length > 0 ? initialSubs : subs)
      })
      .catch(() => setLoading(false))
  }, [curStart, curEnd])

  useEffect(() => {
    if (availableSubs.length === 0) return
    if (checkedSubs.length === 0) {
      setMemos([])
      setTotal(0)
      setLoading(false)
      return
    }
    setLoading(true)
    const isAll = checkedSubs.length === availableSubs.length
    api.fetchIssues({
      categoryMain,
      startDate: curStart,
      endDate: curEnd,
      subs: isAll ? [] : checkedSubs,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    })
      .then(res => {
        setMemos(res.items)
        setTotal(res.total)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [availableSubs, checkedSubs, page])

  function toggleSub(sub: string) {
    setCheckedSubs(prev =>
      prev.includes(sub) ? prev.filter(s => s !== sub) : [...prev, sub]
    )
    setPage(1)
  }

  function toggleAll() {
    setCheckedSubs(prev => prev.length === availableSubs.length ? [] : [...availableSubs])
    setPage(1)
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const allChecked = checkedSubs.length === availableSubs.length
  const isAllRange = !fullDateStart || !fullDateEnd || (curStart === fullDateStart && curEnd === fullDateEnd)
  const showDatePicker = !!(fullDateStart && fullDateEnd && fullDateStart !== fullDateEnd)

  const pager = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#64748b' }}>
      <button
        disabled={page <= 1}
        onClick={() => setPage(p => p - 1)}
        style={{
          border: '1px solid #e2e8f0', borderRadius: 6, padding: '4px 14px',
          background: '#fff', fontSize: 13,
          cursor: page <= 1 ? 'default' : 'pointer',
          color: page <= 1 ? '#cbd5e1' : '#374151',
        }}
      >이전</button>
      <span>{page} / {totalPages} 페이지 (총 {total.toLocaleString()}건)</span>
      <button
        disabled={page >= totalPages}
        onClick={() => setPage(p => p + 1)}
        style={{
          border: '1px solid #e2e8f0', borderRadius: 6, padding: '4px 14px',
          background: '#fff', fontSize: 13,
          cursor: page >= totalPages ? 'default' : 'pointer',
          color: page >= totalPages ? '#cbd5e1' : '#374151',
        }}
      >다음</button>
    </div>
  )

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#fff', borderRadius: 16,
        width: '100%', maxWidth: 960, maxHeight: '90vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
        overflow: 'hidden',
      }}>

        {/* 헤더 */}
        <div style={{
          padding: '18px 32px', borderBottom: '1px solid #e2e8f0',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#1e293b' }}>{categoryMain}</div>
            <div style={{ marginTop: 4 }}>
              <span style={{ fontSize: 15, color: '#475569', fontWeight: 500 }}>{curStart} ~ {curEnd}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 22, color: '#94a3b8', lineHeight: 1, padding: 4,
            }}
          >✕</button>
        </div>

        {/* 날짜 선택 — fullDateStart/End 전달 시 표시 */}
        {showDatePicker && (
          <div style={{
            padding: '10px 32px', borderBottom: '1px solid #f1f5f9',
            flexShrink: 0, background: '#fafafa',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <button
              onClick={() => { setCurStart(fullDateStart!); setCurEnd(fullDateEnd!); setPage(1) }}
              style={{
                padding: '5px 14px', borderRadius: 7, fontSize: 12.5, cursor: 'pointer',
                border: isAllRange ? '1.5px solid #1e3c72' : '1px solid #d1d5db',
                background: isAllRange ? '#1e3c72' : '#fff',
                color: isAllRange ? '#fff' : '#64748b',
                fontWeight: isAllRange ? 700 : 400,
                whiteSpace: 'nowrap',
              }}
            >전체</button>
            <input
              type="date"
              min={fullDateStart}
              max={fullDateEnd}
              value={curStart}
              onChange={e => { if (e.target.value) { setCurStart(e.target.value); setPage(1) } }}
              style={{ border: '1px solid #d1d5db', borderRadius: 7, padding: '5px 10px', fontSize: 13, color: '#374151', background: '#fff', cursor: 'pointer' }}
            />
            <span style={{ fontSize: 13, color: '#94a3b8' }}>~</span>
            <input
              type="date"
              min={fullDateStart}
              max={fullDateEnd}
              value={curEnd}
              onChange={e => { if (e.target.value) { setCurEnd(e.target.value); setPage(1) } }}
              style={{ border: '1px solid #d1d5db', borderRadius: 7, padding: '5px 10px', fontSize: 13, color: '#374151', background: '#fff', cursor: 'pointer' }}
            />
          </div>
        )}

        {/* 소분류 체크박스 필터 */}
        {availableSubs.length > 0 && (
          <div style={{
            padding: '10px 32px', borderBottom: '1px solid #f1f5f9',
            display: 'flex', flexWrap: 'wrap', gap: '6px 20px', alignItems: 'center',
            flexShrink: 0, background: '#fafafa',
          }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input
                type="checkbox" checked={allChecked} onChange={toggleAll}
                style={{ cursor: 'pointer', accentColor: '#1e3c72' }}
              />
              <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>전체</span>
            </label>
            {availableSubs.map(sub => (
              <label key={sub} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input
                  type="checkbox" checked={checkedSubs.includes(sub)} onChange={() => toggleSub(sub)}
                  style={{ cursor: 'pointer', accentColor: '#1e3c72' }}
                />
                <span style={{
                  fontSize: 13, fontWeight: 700,
                  color: checkedSubs.includes(sub) ? '#1e293b' : '#cbd5e1',
                  transition: 'color 0.15s',
                }}>
                  {sub}
                </span>
              </label>
            ))}
          </div>
        )}

        {/* 상단 페이지네이션 */}
        <div style={{ padding: '10px 32px', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
          {pager}
        </div>

        {/* 테이블 — 로딩 중에도 이전 내용 유지, 반투명 오버레이만 표시 */}
        <div style={{ flex: 1, overflowY: 'auto', position: 'relative', padding: '0 20px' }}>
          {loading && memos.length > 0 && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 2,
              background: 'rgba(255,255,255,0.65)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none',
            }}>
              <span style={{
                fontSize: 12, color: '#64748b',
                background: '#fff', padding: '5px 14px',
                borderRadius: 20, border: '1px solid #e2e8f0',
                boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
              }}>조회 중...</span>
            </div>
          )}
          {loading && memos.length === 0 ? (
            <div style={{ padding: '60px 0', textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>조회 중...</div>
          ) : !loading && memos.length === 0 ? (
            <div style={{ padding: '60px 0', textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>메모 없음</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                  {['소분류', '학생번호', '학부모번호', '내용', '등록일'].map(h => (
                    <th key={h} style={{
                      padding: '10px 12px', textAlign: 'left',
                      fontSize: 12, fontWeight: 700, color: '#64748b', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {memos.map(m => (
                  <tr key={m.id} style={{ borderBottom: '1px solid #f8fafc' }}>
                    <td style={{ padding: '9px 12px', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                      {m.new_category_sub
                        ? <span style={{
                            fontSize: 12, fontWeight: 700, color: '#374151',
                            background: '#f1f5f9', borderRadius: 4, padding: '2px 7px',
                          }}>{m.new_category_sub}</span>
                        : <span style={{ color: '#cbd5e1', fontSize: 12 }}>—</span>
                      }
                    </td>
                    <td style={{ padding: '9px 12px', fontSize: 12, color: '#64748b', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                      {m.student_id || '—'}
                    </td>
                    <td style={{ padding: '9px 12px', fontSize: 12, color: '#64748b', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                      {m.parent_id ?? '—'}
                    </td>
                    <td style={{ padding: '9px 12px', fontSize: 13, color: '#374151', lineHeight: 1.6, verticalAlign: 'top' }}>
                      {m.call_memo
                        ? m.call_memo.split('\n').map((line, i) => <span key={i}>{i > 0 && <br />}{line}</span>)
                        : <span style={{ color: '#cbd5e1' }}>—</span>
                      }
                    </td>
                    <td style={{ padding: '9px 12px', fontSize: 12, color: '#94a3b8', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                      {m.created_date ? fmtDate(m.created_date) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 하단 페이지네이션 */}
        <div style={{ padding: '12px 32px', borderTop: '1px solid #f1f5f9', flexShrink: 0 }}>
          {pager}
        </div>
      </div>
    </div>
  )
}
