FROM node:22-alpine AS build
WORKDIR /srv
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w @itsm/worker

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /srv
COPY --from=build /srv/node_modules ./node_modules
COPY --from=build /srv/apps/worker ./apps/worker
USER node
CMD ["node", "apps/worker/dist/main.js"]
