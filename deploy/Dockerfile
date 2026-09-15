# syntax=docker/dockerfile:1

FROM node:20-slim AS base
# Prisma's query engine needs a real OpenSSL + CA trust store to validate the
# RDS server certificate over TLS — node:20-slim ships neither by default.
# Without this, every DB call fails with "self-signed certificate in
# certificate chain" (there's no root CA to validate against at all), and
# `prisma generate` logs "failed to detect the libssl/openssl version".
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# ---- deps: install once, cached across builds ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/utils/package.json packages/utils/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/tailwind-config/package.json packages/tailwind-config/package.json
COPY packages/tsconfig/package.json packages/tsconfig/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/hubspot-app/package.json packages/hubspot-app/package.json
COPY packages/stripe-app/package.json packages/stripe-app/package.json
COPY packages/embeds/core/package.json packages/embeds/core/package.json
COPY packages/embeds/react/package.json packages/embeds/react/package.json
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Next.js build for this app (hundreds of routes) exceeds V8's default ~2GB
# old-space limit inside a container; raise it explicitly. The CodeBuild
# project runs BUILD_GENERAL1_LARGE (15GB RAM) — 4096 still OOM'd, so this
# leaves ~3GB headroom below the container ceiling instead of ~11GB unused.
ENV NODE_OPTIONS=--max-old-space-size=12288
RUN pnpm --filter web prisma:generate
# workspace packages (e.g. @dub/embed-react) must be built before web —
# `pnpm --filter web build` only runs web's own script, it doesn't build
# its workspace dependencies first (confirmed: web's typecheck fails with
# "Cannot find module '@dub/embed-react'" without this step)
RUN pnpm build:packages
RUN pnpm --filter web build

# ---- runtime ----
FROM node:20-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build /app /app
WORKDIR /app/apps/web

EXPOSE 3000
CMD ["pnpm", "start"]
