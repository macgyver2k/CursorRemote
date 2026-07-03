FROM node:20-alpine AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY scripts/build-extraction-fn.mjs scripts/build-extraction-fn.mjs
COPY extension/esbuild.js extension/esbuild.js
COPY scripts/build-client.mjs scripts/build-client.mjs
COPY src src
COPY selectors.json selectors.json
COPY tsconfig.json tsconfig.json

RUN pnpm run build:server

FROM node:20-alpine

WORKDIR /app

RUN mkdir -p data temp

COPY --from=build /app/dist/server/bundle.mjs dist/server/bundle.mjs
COPY --from=build /app/dist/server/extraction-fn.json dist/server/extraction-fn.json
COPY --from=build /app/dist/client dist/client
COPY selectors.json selectors.json
COPY package.json package.json

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV SELECTORS_PATH=/app/selectors.json
ENV CDP_URL=http://host.docker.internal:9222
ENV SERVER_HOST=0.0.0.0
ENV SERVER_PORT=3000

EXPOSE 3000

CMD ["node", "dist/server/bundle.mjs"]
