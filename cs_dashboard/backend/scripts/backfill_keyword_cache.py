# -*- coding: utf-8 -*-
# 과거 날짜별 keyword_trend 캐시를 일괄 생성한다.
# insights_cache에 이미 있는 날짜는 건너뛴다.
# 실행: cd backend && python backfill_keyword_cache.py
#
# 대상 기간: START_DATE ~ 오늘 (매일 1건씩 계산·저장)
# 형태소 분석이 포함되어 있어 날짜당 수 초 소요될 수 있다.

import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from datetime import date, timedelta
from features.stats.stats_endpoints import stats_keyword_trend

START_DATE = date(2026, 5, 15)

def main():
    today = date.today()
    current = START_DATE
    total = (today - START_DATE).days + 1
    done = 0
    skipped = 0

    while current <= today:
        date_str = str(current)
        try:
            result = stats_keyword_trend(target_date=date_str)
            if result:
                print(f"[{date_str}] {len(result)}개 키워드 캐싱 완료")
                done += 1
            else:
                print(f"[{date_str}] 탐지 키워드 없음 (캐시 저장됨)")
                done += 1
        except Exception as e:
            print(f"[{date_str}] 오류: {e}")
            skipped += 1
        current += timedelta(days=1)

    print(f"\n완료: {done}일 처리, {skipped}일 오류 / 전체 {total}일")

if __name__ == "__main__":
    main()
