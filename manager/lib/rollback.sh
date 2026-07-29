#!/usr/bin/env bash
# Image rollback with health-check gating. The update flow (cmd_update) stops
# the api, runs the destructive post migration write-quiet, then starts the new
# container itself; rollback_to_previous is the recovery path when that fails.


rollback_to_previous() {
  warn "AUTO-ROLLBACK: reverting to previous image..."

  docker compose -f "$APP_YML" stop api 2>/dev/null || true

  if declare -F restore_previous_config >/dev/null 2>&1; then
    restore_previous_config || warn "could not restore previous config snapshot"
  fi

  if docker image inspect tokenpanel/app:previous >/dev/null 2>&1; then
    docker tag tokenpanel/app:previous tokenpanel/app:current
    docker compose -f "$APP_YML" up -d --no-deps --force-recreate api

    if wait_for_health api 180; then
      warn "rolled back to previous version — app is serving old code"
      warn "investigate the failure, fix, then retry: tokenpanel update"
      return 0
    else
      err "ROLLBACK FAILED — old container also unhealthy"
      err "manual intervention required. Check: docker logs tokenpanel-api-1"
      err "last resort: tokenpanel restore $BACKUP_DIR/<latest>.gz"
      return 1
    fi
  else
    err "no previous image found — cannot rollback"
    err "manual intervention required."
    return 1
  fi
}
