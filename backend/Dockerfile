# [Docker] 백엔드(FastAPI) 컨테이너 빌드 정의.
# 컨테이너가 시작되면 CMD가 uvicorn으로 server.py의 `app`을 자동 실행한다.
# helpdesk.db는 컨테이너 안이 아니라 docker-compose가 마운트하는 볼륨에 있어야
# 컨테이너를 재빌드해도 데이터가 유지된다 (docker-compose.yml 참고).
#
# TZ=Asia/Seoul: audit_log·collection_log가 SQLite의 datetime('now','localtime')로 시간을
# 저장하는데, 컨테이너 기본 시간대(UTC)에서는 이게 KST가 아니라 UTC로 찍힌다. 개발 PC는
# OS 시간대가 KST라 문제가 안 보였을 뿐 — 컨테이너에도 명시적으로 KST를 지정해야 한다.
#
# playwright install --with-deps chromium: features/mailer/report_screenshot.py가 보고서
# 페이지를 스크린샷 찍는 데 쓰는 헤드리스 크로미움 브라우저를 설치한다. pip install만으로는
# playwright 파이썬 패키지만 들어오고 실제 브라우저 바이너리는 안 들어온다 — 이 단계가 없으면
# 실행 시점에 "브라우저를 찾을 수 없음" 에러가 난다. 이미지 용량·빌드 시간이 늘어난다.

FROM python:3.12-slim

ENV TZ=Asia/Seoul

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN playwright install --with-deps chromium

COPY . .

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
