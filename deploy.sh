#!/usr/bin/env bash
# Thin wrapper so `./deploy.sh` works from the repo root.
# See deploy/deploy.sh for the actual pipeline.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy/deploy.sh" "$@"
