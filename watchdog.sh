#!/usr/bin/env bash
# CYCLE12 WATCHDOG — restart actions-runner/run.sh if it dies
# Target: Flint 1 (macOS ARM64), 49°C passive cooling
set -euo pipefail

RUNNER_DIR="${1:-$HOME/actions-runner}"
LOG_FILE="${2:-$RUNNER_DIR/watchdog.log}"
MAX_RESTARTS="${3:-20}"
BACKOFF_BASE=5
BACKOFF_CAP=300

restart_count=0
last_restart=0

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" | tee -a "$LOG_FILE"
}

while true; do
  if ! pgrep -f "$RUNNER_DIR/bin/Runner.Listener" > /dev/null 2>&1; then
    now=$(date +%s)
    if [ $((now - last_restart)) -lt $BACKOFF_BASE ]; then
      sleep $BACKOFF_BASE
      continue
    fi
    if [ "$restart_count" -ge "$MAX_RESTARTS" ]; then
      log "MAX_RESTARTS ($MAX_RESTARTS) reached. Watchdog halting. Manual intervention required."
      exit 1
    fi
    backoff=$((BACKOFF_BASE * (2 ** restart_count)))
    if [ "$backoff" -gt "$BACKOFF_CAP" ]; then backoff=$BACKOFF_CAP; fi
    log "Runner not detected. Restarting (attempt $((restart_count + 1))/$MAX_RESTARTS) after ${backoff}s backoff."
    cd "$RUNNER_DIR" || { log "Cannot cd to $RUNNER_DIR"; exit 1; }
    nohup ./run.sh >> "$LOG_FILE" 2>&1 &
    last_restart=$now
    restart_count=$((restart_count + 1))
    sleep "$backoff"
  else
    # Runner alive — reset counter and idle
    if [ "$restart_count" -gt 0 ]; then
      log "Runner recovered. Resetting restart counter."
      restart_count=0
    fi
    sleep 30
  fi
done
