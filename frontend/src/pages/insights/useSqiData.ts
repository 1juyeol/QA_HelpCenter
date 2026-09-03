// 서비스 품질 지수(SQI) 데이터 로딩 공용 훅. (일별, 주말·공휴일 제외 — 백엔드 category_daily가 제외 처리)
// SQI = ALLOWED 카테고리(비용성 상담) 건수 ÷ 전체 상담 건수 × 100. 상담 0건인 날은 추가로 제외.
// 기준선 = 구간 초반 절반의 평균. 반환: { loading, points(일별 SQI), latest, baseline, isHigh, peak }.
import { useEffect, useState } from 'react'
import { api, type CategoryDailyRow } from '../../api/client'
import { isAllowed } from '../../api/categories'

export type SqiPoint = { label: string; sqi: number }

export function useSqiData() {
  const [loading, setLoading] = useState(true)
  const [points, setPoints] = useState<SqiPoint[]>([])

  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10)
    load(today)
  }, [])

  async function load(today: string) {
    setLoading(true)
    try {
      const rows = await api.fetchCategoryDaily(today)
      const totalMap: Record<string, number> = {}
      const allowedMap: Record<string, number> = {}
      rows.forEach((r: CategoryDailyRow) => {
        totalMap[r.day] = (totalMap[r.day] ?? 0) + r.count
        if (isAllowed(r.main, r.sub)) allowedMap[r.day] = (allowedMap[r.day] ?? 0) + r.count
      })
      const days = Object.keys(totalMap).filter(d => totalMap[d] > 0).sort()
      setPoints(days.map(d => ({
        label: d.slice(5).replace('-', '/'),
        sqi: Math.round((allowedMap[d] ?? 0) / totalMap[d] * 1000) / 10,
      })))
    } finally {
      setLoading(false)
    }
  }

  const latest = points[points.length - 1] ?? null
  const half = Math.max(1, Math.ceil(points.length / 2))
  const baseline = points.length > 0
    ? points.slice(0, half).reduce((s, p) => s + p.sqi, 0) / half
    : null
  const isHigh = !!(latest && baseline != null && latest.sqi > baseline)
  const peak = points.length ? points.reduce((a, b) => (b.sqi > a.sqi ? b : a)) : null

  return { loading, points, latest, baseline, isHigh, peak }
}
