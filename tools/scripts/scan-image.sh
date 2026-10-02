#!/usr/bin/env bash
# Scans a container image with Trivy; fails on any HIGH or CRITICAL finding that has a fix available.
#   scan-image.sh <image>
# Uses a local `trivy` binary if present, otherwise the aquasec/trivy container image.
# TRIVY_DOCKER_ARGS adds `docker run` flags for the container fallback (e.g. a proxy CA).
# Exceptions go in .trivyignore with a reason and an expiry date (see the file). Keep it empty if you can.
set -euo pipefail

image="${1:?usage: scan-image.sh <image>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
args=(image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --ignorefile /work/.trivyignore --no-progress "$image")

if command -v trivy >/dev/null 2>&1; then
  trivy "${args[@]/\/work\//$root/}"
else
  # shellcheck disable=SC2086 # TRIVY_DOCKER_ARGS is intentionally split into words
  docker run --rm ${TRIVY_DOCKER_ARGS:-} -v /var/run/docker.sock:/var/run/docker.sock -v "$root":/work:ro aquasec/trivy:latest "${args[@]}"
fi
