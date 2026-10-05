# syntax=docker/dockerfile:1

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

FROM deps AS dev
COPY . .
CMD ["npm", "run", "dev", "-w", "@projectplaner/web", "--", "--host", "0.0.0.0"]

FROM deps AS build
COPY . .
RUN npm run build -w @projectplaner/shared && npm run build -w @projectplaner/web

FROM caddy:2-alpine AS runtime
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
