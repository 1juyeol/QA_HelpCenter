# [Docker] 프론트(React+Vite) 컨테이너 빌드 정의.
#
# 2단계(멀티스테이지) 빌드:
#   1) builder — Node로 `npm run build`를 실행해 정적 파일(dist/)을 생성한다.
#      client.ts의 API_BASE는 VITE_API_BASE_URL이 없으면 빈 문자열이라, 별도 build arg 없이도
#      상대경로(/api/...)로 호출되고 nginx.conf가 그걸 backend 컨테이너로 프록시한다.
#   2) 최종 이미지 — nginx가 그 dist/ 결과물만 서빙한다. Node/소스코드는 최종 이미지에 남지 않는다.

FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
# npm ci는 lock 파일에 플랫폼별 옵셔널 의존성(esbuild 등)이 다 있어야 하는데,
# 이 lock 파일은 Windows 개발 PC에서 생성돼 리눅스용 항목이 빠져 있어 실패한다.
# npm install로 해당 플랫폼에 맞게 설치한다 (이 스테이지는 빌드 후 버려지므로 무방).
RUN npm install

COPY . .
RUN npm run build

FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
