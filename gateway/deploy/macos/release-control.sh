#!/bin/bash

set -euo pipefail

ACTIVATION_LOCK=''

fail() {
  printf 'harness-gateway release control: %s\n' "$*" >&2
  exit 1
}

canonical_directory() {
  local path="$1"
  [[ -d "$path" ]] || return 1
  (cd "$path" >/dev/null && pwd -P)
}

load_environment() {
  local env_file="${HGW_GATEWAY_ENV_FILE:-$HOME/.config/harness-gateway/launch.env}"
  [[ -f "$env_file" ]] || fail "environment file not found: $env_file"
  set -a
  # The owner-controlled file uses ordinary shell assignments so values may contain spaces.
  # shellcheck source=/dev/null
  source "$env_file"
  set +a

  RELEASES_ROOT="$(canonical_directory "${HGW_RELEASES_ROOT:-$HOME/harness-gateway-releases}")" \
    || fail "release root not found: ${HGW_RELEASES_ROOT:-$HOME/harness-gateway-releases}"
  NODE="${HGW_NODE:-}"
  [[ -x "$NODE" ]] || fail "HGW_NODE must name an executable Node binary"
  LABEL="${HGW_LAUNCHD_LABEL:-com.maycran.harness-gateway}"
  DOMAIN="${HGW_LAUNCHD_DOMAIN:-gui/$(id -u)}"
  PORT="${HGW_PORT:-8899}"
  ACTIVATION_TIMEOUT_SECONDS="${HGW_ACTIVATION_TIMEOUT_SECONDS:-30}"
  [[ "$PORT" =~ ^[0-9]+$ ]] || fail "HGW_PORT must be an integer"
  [[ "$ACTIVATION_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] \
    || fail "HGW_ACTIVATION_TIMEOUT_SECONDS must be a positive integer"
}

assert_direct_release() {
  local release="$1"
  [[ "$(dirname "$release")" == "$RELEASES_ROOT" ]] \
    || fail "release must be a direct child of $RELEASES_ROOT: $release"
  [[ "$(basename "$release")" != 'current' ]] || fail "current is not an immutable release directory"
}

validate_release() {
  local release="$1"
  local allow_legacy="${2:-false}"
  local required
  for required in \
    apps/cli/lib/bin.js \
    apps/web/dist/index.html \
    gateway/public/admin/index.html \
    gateway/node_modules/pg/package.json \
    gateway/node_modules/argon2/package.json \
    gateway/node_modules/better-sqlite3/package.json \
    plugins/dsh-directory-guard/lib/index.js \
    plugins/dsh-directory-guard/cordis.patch.yml \
    plugins/dsh-model-governance/lib/index.js \
    plugins/dsh-model-governance/cordis.patch.yml
  do
    [[ -s "$release/$required" ]] || fail "release payload is missing or empty: $release/$required"
  done
  if [[ -s "$release/gateway/lib/index.js" \
    && -s "$release/gateway/lib/config.js" \
    && -s "$release/gateway/lib/server.js" \
    && -s "$release/gateway/lib/runtime-api.js" \
    && -s "$release/packages/llm/llm/lib/types/discovery.js" ]]; then
    return 0
  fi
  if [[ "$allow_legacy" == true \
    && -s "$release/gateway/src/index.ts" \
    && -s "$release/gateway/node_modules/tsx/package.json" ]]; then
    return 0
  fi
  fail "release has no complete compiled Gateway payload: $release"
}

current_release() {
  canonical_directory "$RELEASES_ROOT/current"
}

launch_pid() {
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null \
    | awk '$1 == "pid" && $2 == "=" { print $3; exit }'
}

process_cwd() {
  local pid="$1"
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

descendant_pids() {
  local root="$1"
  local parent
  local pid
  local ppid
  local -a queue=("$root")
  local -a found=()

  while ((${#queue[@]} > 0)); do
    parent="${queue[0]}"
    queue=("${queue[@]:1}")
    while read -r pid ppid; do
      [[ -n "$pid" && "$ppid" == "$parent" ]] || continue
      [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
      found+=("$pid")
      queue+=("$pid")
    done < <(ps -axo pid=,ppid=)
  done

  if ((${#found[@]} > 0)); then printf '%s\n' "${found[@]}"; fi
}

terminate_pids() {
  local pids="$1"
  local pid
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    kill -TERM "$pid" 2>/dev/null || true
  done <<< "$pids"
  sleep 1
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    kill -KILL "$pid" 2>/dev/null || true
  done <<< "$pids"
}

health_release() {
  local body
  body="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz")" || return 1
  HEALTH_BODY="$body" "$NODE" -e '
    const value = JSON.parse(process.env.HEALTH_BODY ?? "null")
    if (value?.ok !== true || typeof value.release !== "string") process.exit(1)
    process.stdout.write(value.release)
  '
}

wait_for_release() {
  local expected="$1"
  local previous_pid="$2"
  local expected_id
  local deadline=$((SECONDS + ACTIVATION_TIMEOUT_SECONDS))
  expected_id="$(basename "$expected")"

  while (( SECONDS < deadline )); do
    local observed_release=''
    local observed_pid=''
    local observed_cwd=''
    observed_release="$(health_release 2>/dev/null || true)"
    observed_pid="$(launch_pid || true)"
    if [[ -n "$observed_pid" ]]; then observed_cwd="$(process_cwd "$observed_pid" || true)"; fi
    if [[ "$observed_release" == "$expected_id" \
      && -n "$observed_pid" \
      && "$observed_pid" != "$previous_pid" \
      && "$observed_cwd" == "$expected/gateway" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

switch_current() {
  local release="$1"
  local temporary="$RELEASES_ROOT/.current.$$.tmp"
  rm -f "$temporary"
  ln -s "$release" "$temporary"
  "$NODE" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' \
    "$temporary" "$RELEASES_ROOT/current"
}

run_gateway() {
  load_environment
  local release
  release="$(current_release)" || fail "current does not resolve to a release"
  assert_direct_release "$release"
  # A legacy source release is accepted only when it is already current and
  # launchd is restarting after a failed activation. New activations remain
  # compiled-only; this branch keeps rollback reliable across that upgrade.
  validate_release "$release" true

  export HGW_RELEASE_ROOT="$release"
  unset HGW_DSH_COMMAND HGW_DSH_REPO_ROOT HGW_MODEL_GOVERNANCE_PACKAGE HGW_GATEWAY_DIR
  if [[ "${HGW_GUARD_PATCH:-}" != 'off' ]]; then unset HGW_GUARD_PATCH; fi

  cd "$release/gateway"
  printf '[gateway-launcher] starting release %s\n' "$(basename "$release")"
  if [[ -s "$release/gateway/lib/index.js" ]]; then
    exec "$NODE" "$release/gateway/lib/index.js"
  fi
  exec "$NODE" --import tsx/esm "$release/gateway/src/index.ts"
}

activate_release() {
  [[ $# -eq 1 ]] || fail 'usage: release-control.sh activate <release-directory>'
  load_environment
  local release
  release="$(canonical_directory "$1")" || fail "release directory not found: $1"
  assert_direct_release "$release"
  validate_release "$release"

  ACTIVATION_LOCK="$RELEASES_ROOT/.activation.lock"
  mkdir "$ACTIVATION_LOCK" 2>/dev/null || fail "another release operation holds $ACTIVATION_LOCK"
  trap 'rmdir "$ACTIVATION_LOCK" 2>/dev/null || true' EXIT

  local previous=''
  local previous_pid=''
  local previous_children=''
  previous="$(current_release || true)"
  previous_pid="$(launch_pid || true)"
  if [[ -n "$previous_pid" ]]; then previous_children="$(descendant_pids "$previous_pid")"; fi
  switch_current "$release"

  if launchctl kickstart -k "$DOMAIN/$LABEL"; then
    terminate_pids "$previous_children"
  fi
  if [[ -n "$previous_pid" ]] \
    && [[ -n "$(launch_pid || true)" ]] \
    && [[ "$(launch_pid || true)" == "$previous_pid" ]]; then
    kill -TERM "$previous_pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$previous_pid" 2>/dev/null || true
  fi
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 \
    && wait_for_release "$release" "$previous_pid"; then
    printf 'activated release %s (pid %s)\n' "$(basename "$release")" "$(launch_pid)"
    return 0
  fi

  local failed_pid=''
  failed_pid="$(launch_pid || true)"
  local failed_children=''
  if [[ -n "$failed_pid" ]]; then failed_children="$(descendant_pids "$failed_pid")"; fi
  terminate_pids "$failed_children"
  if [[ -z "$previous" ]]; then
    fail "release $(basename "$release") failed health verification and no previous release exists"
  fi
  switch_current "$previous"
  if launchctl kickstart -k "$DOMAIN/$LABEL"; then
    terminate_pids "$failed_children"
  fi
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 \
    && wait_for_release "$previous" "$failed_pid"; then
    fail "release $(basename "$release") failed health verification; restored $(basename "$previous")"
  fi
  fail "release $(basename "$release") failed health verification and rollback did not become healthy"
}

prune_release() {
  [[ $# -eq 1 ]] || fail 'usage: release-control.sh prune <release-directory>'
  load_environment
  local release
  release="$(canonical_directory "$1")" || fail "release directory not found: $1"
  assert_direct_release "$release"

  local current=''
  current="$(current_release || true)"
  [[ "$release" != "$current" ]] || fail "refusing to delete current release: $release"

  local pid=''
  local cwd=''
  pid="$(launch_pid || true)"
  if [[ -n "$pid" ]]; then cwd="$(process_cwd "$pid" || true)"; fi
  [[ "$cwd" != "$release" && "$cwd" != "$release/"* ]] \
    || fail "refusing to delete release used by gateway pid $pid: $release"

  while read -r process_pid command; do
    [[ "$process_pid" == "$$" || "$process_pid" == "$PPID" ]] && continue
    case "$command" in
      *"$release"*) fail "refusing to delete release referenced by process $process_pid" ;;
    esac
  done < <(ps -axo pid=,command=)

  local open_files=''
  open_files="$(lsof +D "$release" 2>/dev/null || true)"
  [[ -z "$open_files" ]] || fail "refusing to delete release with open files: $release"

  rm -rf "$release"
  printf 'deleted inactive release %s\n' "$(basename "$release")"
}

status() {
  load_environment
  local current=''
  local pid=''
  local cwd=''
  local health=''
  current="$(current_release || true)"
  pid="$(launch_pid || true)"
  if [[ -n "$pid" ]]; then cwd="$(process_cwd "$pid" || true)"; fi
  health="$(health_release 2>/dev/null || true)"
  printf 'current=%s\npid=%s\ncwd=%s\nhealth_release=%s\n' "$current" "$pid" "$cwd" "$health"
}

case "${1:-}" in
  run) shift; [[ $# -eq 0 ]] || fail 'run accepts no arguments'; run_gateway ;;
  activate) shift; activate_release "$@" ;;
  prune) shift; prune_release "$@" ;;
  status) shift; [[ $# -eq 0 ]] || fail 'status accepts no arguments'; status ;;
  *) fail 'usage: release-control.sh {run|activate <release>|prune <release>|status}' ;;
esac
