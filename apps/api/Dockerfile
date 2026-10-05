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
CMD ["npm", "run", "dev", "-w", "@projectplaner/api"]

FROM deps AS build
COPY . .
RUN npm run build -w @projectplaner/shared && npm run build -w @projectplaner/api

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspaces --include-workspace-root --no-audit --no-fund \
  && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY db/migrations db/migrations
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
