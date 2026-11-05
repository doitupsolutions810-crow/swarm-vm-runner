#!/usr/bin/env bash
# Compatibility wrapper: strict proof requires Docker, coordinator + Redis health,
# and completion of this exact job's complete four-role chain.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 "$ROOT/scripts/prove-success-strict.py"
