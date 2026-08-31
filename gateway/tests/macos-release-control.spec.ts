import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const control = resolve(import.meta.dirname, '../deploy/macos/release-control.sh')

function shellValue(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function executable(path: string, source: string): void {
  writeFileSync(path, source)
  chmodSync(path, 0o700)
}

function release(root: string, name: string): string {
  const directory = join(root, name)
  for (const path of [
    'apps/cli/lib/bin.js',
    'apps/web/dist/index.html',
    'gateway/lib/index.js',
    'gateway/lib/config.js',
    'gateway/lib/server.js',
    'gateway/lib/runtime-api.js',
    'gateway/public/admin/index.html',
    'gateway/node_modules/pg/package.json',
    'gateway/node_modules/argon2/package.json',
    'gateway/node_modules/better-sqlite3/package.json',
    'packages/llm/llm/lib/types/discovery.js',
    'plugins/dsh-directory-guard/lib/index.js',
    'plugins/dsh-directory-guard/cordis.patch.yml',
    'plugins/dsh-model-governance/lib/index.js',
    'plugins/dsh-model-governance/cordis.patch.yml',
  ]) {
    const file = join(directory, path)
    mkdirSync(resolve(file, '..'), { recursive: true })
    writeFileSync(file, 'fixture\n')
  }
  return directory
}

function pointCurrent(root: string, target: string): void {
  const current = join(root, 'current')
  if (existsSync(current)) unlinkSync(current)
  symlinkSync(target, current)
}

function environmentFile(root: string, node = process.execPath): string {
  const path = join(root, 'launch.env')
  writeFileSync(path, [
    `HGW_NODE=${shellValue(node)}`,
    `HGW_RELEASES_ROOT=${shellValue(root)}`,
    'HGW_PORT=8899',
    'HGW_ACTIVATION_TIMEOUT_SECONDS=1',
    '',
  ].join('\n'))
  return path
}

function fakeTools(root: string, state: string): string {
  const bin = join(root, 'bin')
  mkdirSync(bin)
  executable(join(bin, 'launchctl'), `#!/bin/bash
set -euo pipefail
case "$1" in
  print)
    printf 'pid = %s\\n' "$(cat "$FAKE_STATE/pid")"
    ;;
  kickstart)
    next=$(( $(cat "$FAKE_STATE/pid") + 1 ))
    printf '%s\\n' "$next" > "$FAKE_STATE/pid"
    current="$(cd "$HGW_RELEASES_ROOT/current" && pwd -P)"
    printf '%s\\n' "$current/gateway" > "$FAKE_STATE/cwd"
    ;;
  *) exit 2 ;;
esac
`)
  executable(join(bin, 'curl'), `#!/bin/bash
set -euo pipefail
current="$(cd "$HGW_RELEASES_ROOT/current" && pwd -P)"
release="$(basename "$current")"
[[ "\${FAKE_FAIL_RELEASE:-}" != "$release" ]] || exit 22
printf '{"ok":true,"release":"%s"}\\n' "$release"
`)
  executable(join(bin, 'lsof'), `#!/bin/bash
set -euo pipefail
if [[ "$1" == '+D' ]]; then exit 1; fi
printf 'p%s\\nfcwd\\nn%s\\n' "$(cat "$FAKE_STATE/pid")" "$(cat "$FAKE_STATE/cwd")"
`)
  mkdirSync(state)
  return bin
}

const macos = describe.skipIf(process.platform !== 'darwin')

macos('macOS release control', () => {
  it('resolves current once and removes independently configured release paths before exec', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-release-run-'))
    const r1 = release(root, 'release-one')
    pointCurrent(root, r1)
    const capture = join(root, 'capture')
    const fakeNode = join(root, 'fake-node')
    executable(fakeNode, `#!/bin/bash
set -euo pipefail
{
  printf 'release_root=%s\\n' "\${HGW_RELEASE_ROOT:-}"
  printf 'dsh_command=%s\\n' "\${HGW_DSH_COMMAND:-}"
  printf 'dsh_repo_root=%s\\n' "\${HGW_DSH_REPO_ROOT:-}"
  printf 'model_package=%s\\n' "\${HGW_MODEL_GOVERNANCE_PACKAGE:-}"
  printf 'gateway_dir=%s\\n' "\${HGW_GATEWAY_DIR:-}"
  printf 'args=%s\\n' "$*"
} > "$CAPTURE"
`)
    const envFile = environmentFile(root, fakeNode)
    writeFileSync(envFile, readFileSync(envFile, 'utf8') + [
      'HGW_DSH_COMMAND=stale-current-command',
      'HGW_DSH_REPO_ROOT=/stale/current',
      'HGW_MODEL_GOVERNANCE_PACKAGE=/stale/current/plugin',
      'HGW_GATEWAY_DIR=/stale/current/gateway',
      '',
    ].join('\n'))

    const result = spawnSync('/bin/bash', [control, 'run'], {
      encoding: 'utf8',
      env: { ...process.env, CAPTURE: capture, HGW_GATEWAY_ENV_FILE: envFile },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(capture, 'utf8')).toBe([
      `release_root=${realpathSync(r1)}`,
      'dsh_command=',
      'dsh_repo_root=',
      'model_package=',
      'gateway_dir=',
      `args=${realpathSync(r1)}/gateway/lib/index.js`,
      '',
    ].join('\n'))
  })

  it('activates only after the new pid, cwd, and health release agree, then rolls back a failed release', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-release-activate-'))
    const r1 = release(root, 'release-one')
    const r2 = release(root, 'release-two')
    pointCurrent(root, r1)
    const envFile = environmentFile(root)
    const state = join(root, 'state')
    const bin = fakeTools(root, state)
    writeFileSync(join(state, 'pid'), '100\n')
    writeFileSync(join(state, 'cwd'), `${realpathSync(r1)}/gateway\n`)
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_STATE: state,
      HGW_GATEWAY_ENV_FILE: envFile,
    }

    const activated = spawnSync('/bin/bash', [control, 'activate', r2], { encoding: 'utf8', env })
    expect(activated.status, activated.stderr).toBe(0)
    expect(realpathSync(join(root, 'current'))).toBe(realpathSync(r2))
    expect(activated.stdout).toContain('activated release release-two (pid 101)')

    pointCurrent(root, r1)
    writeFileSync(join(state, 'pid'), '200\n')
    writeFileSync(join(state, 'cwd'), `${realpathSync(r1)}/gateway\n`)
    const failed = spawnSync('/bin/bash', [control, 'activate', r2], {
      encoding: 'utf8',
      env: { ...env, FAKE_FAIL_RELEASE: 'release-two' },
    })
    expect(failed.status).toBe(1)
    expect(realpathSync(join(root, 'current'))).toBe(realpathSync(r1))
    expect(failed.stderr).toContain('failed health verification; restored release-one')
  })

  it('refuses to prune a release still used by the live gateway after current moved elsewhere', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-release-prune-'))
    const live = release(root, 'release-live')
    const current = release(root, 'release-current')
    pointCurrent(root, current)
    const envFile = environmentFile(root)
    const state = join(root, 'state')
    const bin = fakeTools(root, state)
    writeFileSync(join(state, 'pid'), '300\n')
    writeFileSync(join(state, 'cwd'), `${realpathSync(live)}/gateway\n`)

    const result = spawnSync('/bin/bash', [control, 'prune', live], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_STATE: state,
        HGW_GATEWAY_ENV_FILE: envFile,
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to delete release used by gateway pid 300')
    expect(existsSync(live)).toBe(true)
  })
})
