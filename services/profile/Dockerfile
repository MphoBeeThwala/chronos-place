# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f services/profile/Dockerfile -t chronos/profile .

FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @chronos/profile... build
# Production dependencies only, with workspace packages copied in (not linked).
RUN pnpm --filter @chronos/profile deploy --prod --legacy /out

# checkov:skip=CKV_DOCKER_2: no HEALTHCHECK, distroless has no shell or curl; Kubernetes runs the HTTP and gRPC probes
# Distroless: no shell, no package manager, runs as user 65532. Pinned by digest.
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c
WORKDIR /app
COPY --from=build --chown=65532:65532 /out /app
ENV NODE_ENV=production
USER 65532:65532
EXPOSE 8080 50051
# The image entrypoint is node; --import starts telemetry before any module is loaded.
CMD ["--import", "@chronos/service-kit/instrument", "dist/main.js"]
