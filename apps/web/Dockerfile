FROM node:22-alpine AS build
WORKDIR /srv
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/workflow/package.json packages/workflow/package.json
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w @itsm/contracts && npm run build -w @itsm/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /srv/apps/web/dist /usr/share/nginx/html
EXPOSE 80
