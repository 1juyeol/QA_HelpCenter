# [Docker] 백엔드(FastAPI) 컨테이너 빌드 정의.
# 컨테이너가 시작되면 CMD가 uvicorn으로 server.py의 `app`을 자동 실행한다.
# helpdesk.db는 컨테이너 안이 아니라 docker-compose가 마운트하는 볼륨에 있어야
# 컨테이너를 재빌드해도 데이터가 유지된다 (docker-compose.yml 참고).

FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
