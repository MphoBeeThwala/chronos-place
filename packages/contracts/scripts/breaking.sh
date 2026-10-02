#!/usr/bin/env bash
# Fails if the protobuf contracts break compatibility with the base branch.
#   AGAINST_REF  git ref to compare with (default: origin/main, falling back to main)
# Skips with a notice when the base ref does not contain the contracts package yet.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ref="${AGAINST_REF:-origin/main}"
git rev-parse --verify --quiet "$ref" >/dev/null || ref="main"

if ! git cat-file -e "$ref:packages/contracts/buf.yaml" 2>/dev/null; then
  echo "No contracts at $ref yet; nothing to compare against."
  exit 0
fi

npx buf breaking --against "$(git rev-parse --show-toplevel)/.git#ref=$ref,subdir=packages/contracts"
