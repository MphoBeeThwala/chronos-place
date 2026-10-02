# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f __SCOPE_DIR__/__NAME__/Dockerfile -t chronos/__NAME__ .

FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @chronos/__NAME__... build
# Production dependencies only, with workspace packages copied in (not linked).
RUN pnpm --filter @chronos/__NAME__ deploy --prod --legacy /out

# checkov:skip=CKV_DOCKER_2: no HEALTHCHECK, distroless has no shell or curl; Kubernetes runs the HTTP and gRPC probes
# Distroless: no shell, no package manager, runs as user 65532. Pinned by digest.
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:__DISTROLESS_DIGEST__
WORKDIR /app
COPY --from=build --chown=65532:65532 /out /app
ENV NODE_ENV=production
USER 65532:65532
EXPOSE 8080 50051
# The image entrypoint is node; --import starts telemetry before any module is loaded.
CMD ["--import", "@chronos/service-kit/instrument", "dist/main.js"]
