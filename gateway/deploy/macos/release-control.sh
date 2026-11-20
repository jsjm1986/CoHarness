#!/bin/bash

set -euo pipefail

RELEASE_LOCK=''

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

  RELEASES_CONFIGURED="${HGW_RELEASES_ROOT:-$HOME/harness-gateway-releases}"
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
  local current=''
  current="$(canonical_directory "$RELEASES_ROOT/current" || true)"
  if [[ -n "$current" && -s "$current/gateway/lib/node-config-cli.js" ]]; then
    PORT="$("$NODE" "$current/gateway/lib/node-config-cli.js" port)" \
      || fail 'managed node configuration could not be read; use the local node-config recovery command'
  fi
}

lock_release_operations() {
  RELEASE_LOCK="$RELEASES_ROOT/.activation.lock"
  mkdir "$RELEASE_LOCK" 2>/dev/null || fail "another release operation holds $RELEASE_LOCK"
  trap 'rmdir "$RELEASE_LOCK" 2>/dev/null || true' EXIT
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
  local manifest="$release/gateway/deploy/required-release-files.txt"
  if [[ -f "$release/gateway/lib/launch-stamp.js" ]] \
    && grep -qF './runtime-dependency-fingerprint.js' "$release/gateway/lib/launch-stamp.js"; then
    for required in "$manifest" "$release/gateway/lib/runtime-dependencies.json" "$release/gateway/lib/runtime-dependency-fingerprint.js"; do
      [[ -f "$required" && -s "$required" ]] || fail "release payload is missing or empty: $required"
    done
  fi
  if [[ -e "$manifest" ]]; then
    [[ -f "$manifest" && -s "$manifest" ]] || fail "release manifest is missing or invalid: $manifest"
    local has_supervisor=false
    while IFS= read -r required || [[ -n "$required" ]]; do
      [[ "$required" =~ ^[A-Za-z0-9_-][A-Za-z0-9_./-]*$ && "/$required/" != *'/../'* && "/$required/" != *'/./'* && "$required" != *'//'* && "$required" != */ ]] \
        || fail "release manifest contains an invalid path: $manifest"
      [[ -f "$release/$required" && -s "$release/$required" ]] || fail "release payload is missing or empty: $release/$required"
      if [[ "$required" == 'gateway/lib/local-runtime-supervisor.js' ]]; then has_supervisor=true; fi
    done < "$manifest"
    [[ "$has_supervisor" == true ]] || fail "release manifest omits the local Runtime supervisor: $manifest"
    if [[ "$allow_legacy" == false && -s "$release/gateway/lib/runtime-dependencies.json" ]]; then
      "$NODE" "$release/gateway/lib/runtime-dependency-fingerprint.js" --verify-release "$release" \
        || fail "release Runtime dependencies differ from the built fingerprint: $release"
    fi
  elif [[ -f "$release/gateway/lib/launcher.js" ]] && grep -qF 'local-runtime-supervisor.' "$release/gateway/lib/launcher.js"; then
    [[ -f "$release/gateway/lib/local-runtime-supervisor.js" && -s "$release/gateway/lib/local-runtime-supervisor.js" ]] \
      || fail "release payload is missing or empty: $release/gateway/lib/local-runtime-supervisor.js"
  fi
  for required in \
    apps/cli/lib/bin.js \
    apps/web/dist/index.html \
    gateway/public/admin/index.html \
    gateway/node_modules/pg/package.json \
    gateway/node_modules/argon2/package.json \
    gateway/node_modules/better-sqlite3/package.json \
    gateway/deploy/windows/node-agent-task.ps1 \
    plugins/dsh-directory-guard/lib/index.js \
    plugins/dsh-directory-guard/cordis.patch.yml \
    plugins/dsh-model-governance/lib/index.js \
    plugins/dsh-model-governance/cordis.patch.yml \
    plugins/dsh-steward-tools/lib/index.js \
    plugins/dsh-steward-tools/cordis.patch.yml
  do
    [[ -s "$release/$required" ]] || fail "release payload is missing or empty: $release/$required"
  done
  if [[ -s "$release/gateway/lib/index.js" \
    && -s "$release/gateway/lib/config.js" \
    && -s "$release/gateway/lib/server.js" \
    && -s "$release/gateway/lib/runtime-api.js" \
    && -s "$release/packages/llm/llm/lib/types/discovery.js" \
    && -s "$release/packages/session/session-format/lib/index.js" \
    && -s "$release/packages/session/session-format/lib/types/surface.js" ]]; then
    # The flock binding and the Landlock launcher are gitignored build outputs
    # required at first session lock, not at boot; require the host platform's
    # payloads so an incomplete release is refused before it goes live. Legacy
    # source releases predate the addon and stay exempt below.
    local -a native_paths=(
      native/system/packages/entry/lib/index.js
      native/system/packages/entry/lib/flock.js
    )
    case "$(uname -s)-$(uname -m)" in
      Darwin-arm64)         native_paths+=(native/system/packages/darwin-arm64/bin/system.node) ;;
      Darwin-x86_64)        native_paths+=(native/system/packages/darwin-x64/bin/system.node) ;;
      Linux-x86_64)         native_paths+=(native/system/packages/linux-x64/bin/landlock-run native/system/packages/linux-x64/bin/glibc/system.node native/system/packages/linux-x64/bin/musl/system.node) ;;
      Linux-aarch64|Linux-arm64)
                            native_paths+=(native/system/packages/linux-arm64/bin/landlock-run native/system/packages/linux-arm64/bin/glibc/system.node native/system/packages/linux-arm64/bin/musl/system.node) ;;
      *) fail "unsupported host for native-artifact check: $(uname -s)/$(uname -m)" ;;
    esac
    for required in "${native_paths[@]}"; do
      [[ -s "$release/$required" ]] || fail "release payload is missing or empty: $release/$required"
    done
    # The compiled ESM graph resolves workspace packages through release-local
    # links that `build:production` creates under gateway/node_modules. A
    # release assembled without them boots into an unresolved-import crash, so
    # require the base links here and each newer module's additions below.
    # The full build list lives in scripts/gateway-runtime-packages.ts.
    local -a runtime_links=(
      cordis
      schemastery
      dsh-managed-data
      dsh-atomic-write
      dsh-native-command
      dsh-llm
      dsh-session-format
      dsh-session-format-catalog
      dsh-home-paths
      dsh-userdoc
      dsh-userdoc-local
      dsh-host-userdoc-http
    )
    if [[ -f "$release/gateway/lib/peer-backup-takeover-schedule.js" ]]; then runtime_links+=(dsh-schedule); fi
    for required in "${runtime_links[@]}"; do
      [[ -s "$release/gateway/node_modules/@deepseek-ai/$required/package.json" ]] \
        || fail "release Gateway runtime link is missing or broken: $release/gateway/node_modules/@deepseek-ai/$required"
    done
    if grep -qF './gateway-model-budget.js' "$release/gateway/lib/index.js"; then
      for required in \
        gateway/lib/gateway-model-budget.js \
        gateway/lib/postgres/progress-usage.js \
        gateway/lib/postgres/progress-service.js \
        native/system/packages/entry/lib/flock.js \
        gateway/node_modules/@deepseek-ai/node-addon-system/package.json \
        gateway/deploy/postgres/migrations/065_gateway_model_ownership.sql \
        gateway/deploy/postgres/migrations/066_project_journal_generation.sql \
        gateway/deploy/postgres/migrations/067_project_journal_requests.sql \
        gateway/deploy/postgres/migrations/068_project_journal_visibility.sql
      do
        [[ -s "$release/$required" ]] || fail "release Gateway model admission payload is missing or empty: $release/$required"
      done
    fi
    if [[ -f "$release/gateway/lib/postgres/progress-service.js" ]] \
      && grep -qF 'project_journal_materials' "$release/gateway/lib/postgres/progress-service.js"; then
      [[ -s "$release/gateway/deploy/postgres/migrations/069_project_journal_materials.sql" ]] \
        || fail "release Gateway model admission payload is missing or empty: $release/gateway/deploy/postgres/migrations/069_project_journal_materials.sql"
    fi
    if [[ -f "$release/gateway/lib/postgres/progress-usage.js" ]] \
      && grep -qF 'request_session' "$release/gateway/lib/postgres/progress-usage.js"; then
      for required in \
        gateway/deploy/postgres/migrations/070_project_journal_request_sessions.sql \
        gateway/deploy/postgres/migrations/071_project_journal_request_deletion.sql \
        packages/core/session/lib/index.js \
        gateway/node_modules/@deepseek-ai/dsh-session/package.json
      do
        [[ -s "$release/$required" ]] || fail "release Gateway model admission payload is missing or empty: $release/$required"
      done
    fi
    if [[ -f "$release/gateway/lib/node-resource-budget.js" ]] \
      && grep -qF 'sampled_before' "$release/gateway/lib/node-resource-budget.js"; then
      [[ -s "$release/gateway/deploy/postgres/migrations/072_node_pressure_capture_bounds.sql" ]] \
        || fail "release resource admission payload is missing or empty: $release/gateway/deploy/postgres/migrations/072_node_pressure_capture_bounds.sql"
    fi
    if [[ -f "$release/gateway/lib/postgres/project-service.js" ]] \
      && grep -qF 'mutationUser' "$release/gateway/lib/postgres/project-service.js"; then
      [[ -s "$release/gateway/deploy/postgres/migrations/073_deleted_project_relationships.sql" ]] \
        || fail "release project account deletion payload is missing or empty: $release/gateway/deploy/postgres/migrations/073_deleted_project_relationships.sql"
    fi
    if [[ -f "$release/gateway/lib/postgres/model-governance-service.js" ]] \
      && grep -qF 'mutationUser' "$release/gateway/lib/postgres/model-governance-service.js"; then
      [[ -s "$release/gateway/deploy/postgres/migrations/074_deleted_model_relationships.sql" ]] \
        || fail "release model account deletion payload is missing or empty: $release/gateway/deploy/postgres/migrations/074_deleted_model_relationships.sql"
    fi
    if grep -qF './runtime-resource-api.js' "$release/gateway/lib/runtime-api.js"; then
      for required in \
        gateway/lib/runtime-resource-api.js \
        gateway/lib/node-resource-budget.js \
        gateway/lib/node-resource-pressure.js \
        packages/context/resource-budget/lib/wire.js \
        gateway/node_modules/@deepseek-ai/dsh-resource-budget/package.json
      do
        [[ -s "$release/$required" ]] || fail "release resource admission payload is missing or empty: $release/$required"
      done
    fi
    if grep -qF './runtime-document-store.js' "$release/gateway/lib/runtime-api.js"; then
      for required in \
        gateway/lib/runtime-document-store.js \
        packages/attachment/userdoc-gateway/lib/protocol.js \
        packages/util/values/lib/index.js \
        gateway/node_modules/@deepseek-ai/dsh-userdoc-gateway/package.json \
        gateway/node_modules/@deepseek-ai/dsh-util-values/package.json
      do
        [[ -f "$release/$required" && -s "$release/$required" ]] \
          || fail "release document payload is missing or empty: $release/$required"
      done
      "$NODE" --input-type=module -e \
        'import { pathToFileURL } from "node:url"; await import(pathToFileURL(process.argv[1]).href)' \
        "$release/gateway/lib/runtime-api.js" \
        || fail "release document module graph is incomplete: $release/gateway/lib/runtime-api.js"
    fi
    return 0
  fi
  if [[ "$allow_legacy" == true \
    && -s "$release/gateway/src/index.ts" \
    && -s "$release/gateway/node_modules/tsx/package.json" ]]; then
    return 0
  fi
  fail "release has no complete compiled Gateway payload: $release"
}

activation_target() {
  local requested="$1"
  # Preserve the mutable alias name before canonical_directory resolves it.
  while [[ "$requested" == */ || "$requested" == */. ]]; do
    if [[ "$requested" == */. ]]; then requested="${requested%/.}"
    else requested="${requested%/}"; fi
  done
  [[ "${requested##*/}" != 'current' ]] || fail "current is not an immutable release directory"
  local release
  release="$(canonical_directory "$1")" || fail "release directory not found: $1"
  assert_direct_release "$release"
  validate_release "$release"
  printf '%s\n' "$release"
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

assert_stopped_deployment() {
  local state=''
  state="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null)" \
    || fail 'cannot inspect the registered Gateway job; no release or process was changed'
  local pid=''
  pid="$(printf '%s\n' "$state" | awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
  [[ -z "$pid" ]] || fail "Gateway pid $pid is running; enter maintenance, verify Runtime and scheduled-work shutdown, then stop the Gateway before activation; no process was stopped"
  local processes=''
  processes="$(ps -axo pid=,command=)" || fail 'cannot inspect Runtime processes; activation refused'
  local process_pid command
  while read -r process_pid command; do
    [[ "$process_pid" == "$$" || "$process_pid" == "$PPID" ]] && continue
    case "$command" in
      *"$RELEASES_ROOT/"*|*"$RELEASES_CONFIGURED/"*)
        case "$command" in
          *local-runtime-supervisor*|*apps/cli/lib/bin.js*|*gateway/lib/index.js*)
            fail "release process $process_pid is still running; retained Runtime work may include long tasks and schedules; no process was stopped" ;;
        esac ;;
    esac
  done <<< "$processes"
}

preflight() {
  load_environment
  assert_stopped_deployment
  printf 'Gateway and release Runtime processes are stopped; activation does not stop work or establish a maintenance window\n'
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

release_schema_checker() {
  local owner
  for owner in "$@"; do
    if [[ -n "$owner" && "$(dirname "$owner")" == "$RELEASES_ROOT" && -s "$owner/gateway/lib/release-schema-check.js" ]]; then
      printf '%s\n' "$owner/gateway/lib/release-schema-check.js"
      return 0
    fi
  done
  return 1
}

check_release_schema() (
  local checker="$1" mode="$2" candidate="$3" selected="$4"
  unset HGW_DSH_COMMAND HGW_DSH_REPO_ROOT HGW_MODEL_GOVERNANCE_PACKAGE HGW_GATEWAY_DIR
  if [[ "${HGW_GUARD_PATCH:-}" != 'off' ]]; then unset HGW_GUARD_PATCH; fi
  cd "$selected/gateway" || return 1
  if [[ -s "$selected/gateway/lib/index.js" ]]; then
    "$NODE" "$checker" "$mode" "$candidate" "$selected"
  else
    "$NODE" --import tsx/esm "$checker" "$mode" "$candidate" "$selected"
  fi
)

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

run_node_config() {
  [[ $# -eq 1 ]] || fail 'usage: release-control.sh config <watch|status|apply|recover>'
  case "$1" in watch|status|apply|recover) ;; *) fail 'invalid node configuration action' ;; esac
  load_environment
  local release
  release="$(current_release)" || fail 'no active release'
  [[ -s "$release/gateway/lib/node-config-cli.js" ]] || fail 'active release has no node configuration applier'
  export HGW_RELEASE_ROOT="$release"
  unset HGW_DSH_COMMAND HGW_DSH_REPO_ROOT HGW_MODEL_GOVERNANCE_PACKAGE HGW_GATEWAY_DIR
  if [[ "${HGW_GUARD_PATCH:-}" != 'off' ]]; then unset HGW_GUARD_PATCH; fi
  cd "$release/gateway"
  exec "$NODE" "$release/gateway/lib/node-config-cli.js" "$1"
}

activate_release() {
  case "$#" in
    1) ;;
    3) [[ "$2" == '--rollback-target' ]] || fail 'usage: release-control.sh activate <release-directory> [--rollback-target <release-directory>]' ;;
    *) fail 'usage: release-control.sh activate <release-directory> [--rollback-target <release-directory>]' ;;
  esac
  load_environment
  lock_release_operations
  local release
  release="$(activation_target "$1")"
  local rollback=''
  if [[ $# -eq 3 ]]; then
    rollback="$(activation_target "$3")"
    [[ "$rollback" != "$release" ]] || fail 'rollback target must differ from the activated release'
  fi

  local previous=''
  previous="$(current_release || true)"
  if [[ -z "$rollback" && "$previous" != "$release" ]]; then rollback="$previous"; fi
  assert_stopped_deployment
  local checker
  checker="$(release_schema_checker "$release" "$previous" "$rollback")" \
    || fail 'no installed release schema checker is available; stage a release that provides it'
  check_release_schema "$checker" activate "$release" "$release" \
    || fail "activation refused because database schema compatibility for $(basename "$release") could not be proved"
  assert_stopped_deployment
  switch_current "$release"

  # Without -k, a concurrent launch is never terminated to force activation.
  if launchctl enable "$DOMAIN/$LABEL" && launchctl kickstart "$DOMAIN/$LABEL" && wait_for_release "$release" ''; then
    if launchctl print "$DOMAIN/$LABEL-config" >/dev/null 2>&1; then
      launchctl kickstart -k "$DOMAIN/$LABEL-config" || fail 'Gateway activated but the configuration applier could not restart'
    fi
    printf 'activated release %s (pid %s)\n' "$(basename "$release")" "$(launch_pid)"
    return 0
  fi

  # An unhealthy candidate can already own work. A live or unobservable process
  # keeps its release selected; rollback must not signal it or its descendants.
  if ! (assert_stopped_deployment); then
    fail "release $(basename "$release") failed health verification; candidate retained because shutdown is not confirmed; no process was stopped"
  fi
  [[ -n "$rollback" ]] || fail "release $(basename "$release") failed health verification and no previous release exists"
  # launchd can retry a failed KeepAlive job while the database is being checked.
  launchctl disable "$DOMAIN/$LABEL" \
    || fail "release $(basename "$release") failed health verification; rollback refused because automatic Gateway launch could not be paused"
  if ! (assert_direct_release "$rollback" && validate_release "$rollback" true \
    && check_release_schema "$checker" rollback "$release" "$rollback"); then
    fail "release $(basename "$release") failed health verification; rollback $(basename "$rollback") refused because compatibility with the installed database schemas could not be proved; current remains selected and automatic Gateway launch is paused"
  fi
  assert_stopped_deployment
  [[ "$(current_release || true)" == "$release" ]] || fail 'current changed during database schema verification; rollback refused'
  switch_current "$rollback"
  if launchctl enable "$DOMAIN/$LABEL" && launchctl kickstart "$DOMAIN/$LABEL" && wait_for_release "$rollback" ''; then
    fail "release $(basename "$release") failed health verification; restored $(basename "$rollback")"
  fi
  fail "release $(basename "$release") failed health verification and rollback $(basename "$rollback") did not become healthy"
}

prune_release() {
  [[ $# -eq 1 ]] || fail 'usage: release-control.sh prune <release-directory>'
  load_environment
  lock_release_operations
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

  # Capture the process table before scanning: a live <(ps) substitution would
  # list its own fork under this script's argv, which contains $release.
  local process_table=''
  process_table="$(ps -axo pid=,command=)"
  while read -r process_pid command; do
    [[ "$process_pid" == "$$" || "$process_pid" == "$PPID" ]] && continue
    case "$command" in
      *"$release"*) fail "refusing to delete release referenced by process $process_pid" ;;
    esac
  done <<< "$process_table"

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
  config) shift; run_node_config "$@" ;;
  activate) shift; activate_release "$@" ;;
  prune) shift; prune_release "$@" ;;
  status) shift; [[ $# -eq 0 ]] || fail 'status accepts no arguments'; status ;;
  preflight) shift; [[ $# -eq 0 ]] || fail 'preflight accepts no arguments'; preflight ;;
  *) fail 'usage: release-control.sh {run|config <watch|status|apply|recover>|activate <release> [--rollback-target <release>]|prune <release>|status|preflight}' ;;
esac
