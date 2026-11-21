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
RUN npm run build -w @itsm/contracts && npm run build -w @itsm/workflow && npm run build -w @itsm/api

FROM node:22-alpine
RUN apk add --no-cache ffmpeg
RUN mkdir -p /var/lib/itsm/attachments && chown node:node /var/lib/itsm/attachments && chmod 700 /var/lib/itsm/attachments
ENV NODE_ENV=production PORT=3000
WORKDIR /srv
COPY --from=build /srv/node_modules ./node_modules
COPY --from=build /srv/packages/contracts ./packages/contracts
COPY --from=build /srv/packages/workflow ./packages/workflow
COPY --from=build /srv/apps/api ./apps/api
COPY --from=build /srv/db ./db
COPY --from=build /srv/scripts/migrate.mjs ./scripts/migrate.mjs
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
