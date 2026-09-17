#!/usr/bin/env bash
set -euo pipefail
data="${SWARM_DATA:-/var/swarm}"
mkdir -p "$data/artifacts" "$data/logs"
while true; do
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  used="$(du -sh "$data" 2>/dev/null | awk '{print $1}')"
  echo "${ts} swarm-data=${used}" >>"$data/logs/maintain.log"
  find "$data/logs" -type f -mtime +7 -delete 2>/dev/null || true
  sleep 60
done
