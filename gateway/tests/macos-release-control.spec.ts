import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it, onTestFinished } from 'vitest'

const control = resolve(import.meta.dirname, '../deploy/macos/release-control.sh')

function shellValue(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function executable(path: string, source: string): void {
  writeFileSync(path, source)
  chmodSync(path, 0o700)
}

/** The host-platform addon payloads `validate_release` requires of a compiled release. */
function hostNativePaths(): string[] {
  const uname = (flag: string): string =>
    spawnSync('uname', [flag], { encoding: 'utf8' }).stdout.trim()
  const linux = (arch: string): string[] => [
    `native/system/packages/linux-${arch}/bin/landlock-run`,
    `native/system/packages/linux-${arch}/bin/glibc/system.node`,
    `native/system/packages/linux-${arch}/bin/musl/system.node`,
  ]
  switch (`${uname('-s')}-${uname('-m')}`) {
    case 'Darwin-arm64':
      return ['native/system/packages/darwin-arm64/bin/system.node']
    case 'Darwin-x86_64':
      return ['native/system/packages/darwin-x64/bin/system.node']
    case 'Linux-x86_64':
      return linux('x64')
    case 'Linux-aarch64':
    case 'Linux-arm64':
      return linux('arm64')
    default:
      return []
  }
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
    'gateway/lib/runtime-resource-api.js',
    'gateway/lib/node-resource-budget.js',
    'gateway/lib/node-resource-pressure.js',
    'packages/context/resource-budget/lib/wire.js',
    'gateway/public/admin/index.html',
    'gateway/node_modules/pg/package.json',
    'gateway/node_modules/argon2/package.json',
    'gateway/node_modules/better-sqlite3/package.json',
    ...['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-managed-data', '@deepseek-ai/dsh-atomic-write', '@deepseek-ai/dsh-native-command',
      '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session-format', '@deepseek-ai/dsh-session-format-catalog',
      '@deepseek-ai/dsh-home-paths', '@deepseek-ai/dsh-userdoc', '@deepseek-ai/dsh-userdoc-local',
      '@deepseek-ai/dsh-host-userdoc-http', '@deepseek-ai/dsh-resource-budget']
      .map(packageName => `gateway/node_modules/${packageName}/package.json`),
    'packages/llm/llm/lib/types/discovery.js',
    'packages/session/session-format/lib/index.js',
    'packages/session/session-format/lib/types/surface.js',
    'plugins/dsh-directory-guard/lib/index.js',
    'plugins/dsh-directory-guard/cordis.patch.yml',
    'plugins/dsh-model-governance/lib/index.js',
    'plugins/dsh-model-governance/cordis.patch.yml',
    'plugins/dsh-steward-tools/lib/index.js',
    'plugins/dsh-steward-tools/cordis.patch.yml',
    'native/system/packages/entry/lib/index.js',
    'native/system/packages/entry/lib/flock.js',
    ...hostNativePaths(),
  ]) {
    const file = join(directory, path)
    mkdirSync(resolve(file, '..'), { recursive: true })
    writeFileSync(file, 'fixture\n')
  }
  writeFileSync(join(directory, 'gateway/lib/runtime-api.js'), "import './runtime-resource-api.js'\n")
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
printf 'launchctl %s\\n' "$*" >> "$FAKE_STATE/actions"
case "$1" in
  print)
    if [[ "$2" == *-config ]]; then [[ "\${FAKE_CONFIG_APPLIER:-}" == 1 ]] || exit 1; fi
    printf 'pid = %s\\n' "$(cat "$FAKE_STATE/pid")"
    ;;
  kickstart)
    if [[ "$3" == *-config ]]; then printf 'restarted\\n' > "$FAKE_STATE/config-applier"; exit 0; fi
    next=$(( $(cat "$FAKE_STATE/pid") + 1 ))
    printf '%s\\n' "$next" > "$FAKE_STATE/pid"
    current="$(cd "$HGW_RELEASES_ROOT/current" && pwd -P)"
    printf '%s\\n' "$current/gateway" > "$FAKE_STATE/cwd"
    basename "$current" >> "$FAKE_STATE/started"
    ;;
  *) exit 2 ;;
esac
`)
  executable(join(bin, 'curl'), `#!/bin/bash
set -euo pipefail
current="$(cd "$HGW_RELEASES_ROOT/current" && pwd -P)"
release="$(basename "$current")"
[[ "\${FAKE_FAIL_RELEASE:-}" != "$release" ]] || exit 22
[[ "\${FAKE_FAIL_ROLLBACK_RELEASE:-}" != "$release" ]] || exit 22
printf '{"ok":true,"release":"%s"}\\n' "\${FAKE_HEALTH_RELEASE:-$release}"
`)
  executable(join(bin, 'lsof'), `#!/bin/bash
set -euo pipefail
if [[ "$1" == '+D' ]]; then exit 1; fi
printf 'p%s\\nfcwd\\nn%s\\n' "$(cat "$FAKE_STATE/pid")" "$(cat "$FAKE_STATE/cwd")"
`)
  executable(join(bin, 'ps'), `#!/bin/bash
set -euo pipefail
printf 'ps %s\\n' "$*" >> "$FAKE_STATE/actions"
if [[ -f "$FAKE_STATE/processes" ]]; then cat "$FAKE_STATE/processes"; fi
`)
  mkdirSync(state)
  return bin
}

function activationFixture() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-release-fallback-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const previous = release(root, 'release-previous')
  const candidate = release(root, 'release-candidate')
  const fallback = release(root, 'release-compatible')
  pointCurrent(root, previous)
  const currentInode = lstatSync(join(root, 'current')).ino
  const envFile = environmentFile(root)
  const state = join(root, 'state')
  const bin = fakeTools(root, state)
  writeFileSync(join(state, 'pid'), '60000\n')
  writeFileSync(join(state, 'cwd'), `${realpathSync(previous)}/gateway\n`)
  writeFileSync(join(state, 'processes'), '910001 60000\n910002 70000\n910003 60001\n')
  const shellEnv = join(root, 'shell.env')
  // Bash's builtin kill cannot be intercepted by a PATH executable.
  writeFileSync(shellEnv, 'kill() { printf \'kill %s\\n\' "$*" >> "$FAKE_STATE/actions"; }\n')
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    BASH_ENV: shellEnv,
    FAKE_STATE: state,
    HGW_GATEWAY_ENV_FILE: envFile,
    FAKE_FAIL_RELEASE: '',
    FAKE_FAIL_ROLLBACK_RELEASE: '',
    FAKE_HEALTH_RELEASE: '',
    FAKE_CONFIG_APPLIER: '',
  }
  const activate = (args: string[], overrides: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync('/bin/bash', [control, 'activate', ...args], {
      encoding: 'utf8', env: { ...env, ...overrides }, timeout: 25_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    return result
  }
  const actions = (): string => existsSync(join(state, 'actions')) ? readFileSync(join(state, 'actions'), 'utf8') : ''
  const expectUnchanged = (): void => {
    expect(realpathSync(join(root, 'current'))).toBe(realpathSync(previous))
    expect(lstatSync(join(root, 'current')).ino).toBe(currentInode)
    expect(readFileSync(join(state, 'pid'), 'utf8')).toBe('60000\n')
    expect(actions()).toBe('')
    expect(existsSync(join(root, '.activation.lock'))).toBe(false)
  }
  return { root, previous, candidate, fallback, state, activate, actions, expectUnchanged }
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

  it('keeps a legacy source release usable as a rollback target', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-release-legacy-'))
    const legacy = release(root, 'legacy-release')
    for (const path of [
      'gateway/lib/index.js',
      'gateway/lib/config.js',
      'gateway/lib/server.js',
      'gateway/lib/runtime-api.js',
      'packages/llm/llm/lib/types/discovery.js',
      'packages/session/session-format/lib/index.js',
      'packages/session/session-format/lib/types/surface.js',
    ]) unlinkSync(join(legacy, path))
    mkdirSync(join(legacy, 'gateway/src'), { recursive: true })
    mkdirSync(join(legacy, 'gateway/node_modules/tsx'), { recursive: true })
    writeFileSync(join(legacy, 'gateway/src/index.ts'), 'export {}\n')
    writeFileSync(join(legacy, 'gateway/node_modules/tsx/package.json'), '{}\n')
    pointCurrent(root, legacy)
    const capture = join(root, 'capture')
    const fakeNode = join(root, 'fake-node')
    executable(fakeNode, `#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" > "$CAPTURE"
`)
    const envFile = environmentFile(root, fakeNode)
    const result = spawnSync('/bin/bash', [control, 'run'], {
      encoding: 'utf8',
      env: { ...process.env, CAPTURE: capture, HGW_GATEWAY_ENV_FILE: envFile },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(capture, 'utf8')).toBe(
      `--import tsx/esm ${realpathSync(legacy)}/gateway/src/index.ts\n`,
    )
  })

  it.each([
    'packages/session/session-format/lib/index.js',
    'packages/session/session-format/lib/types/surface.js',
    'gateway/lib/runtime-resource-api.js',
    'gateway/lib/node-resource-budget.js',
    'gateway/lib/node-resource-pressure.js',
    'packages/context/resource-budget/lib/wire.js',
    'gateway/node_modules/@deepseek-ai/dsh-resource-budget/package.json',
  ])('rejects a compiled release missing %s before switching current', (missing) => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-release-missing-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const previous = release(root, 'release-one')
    const candidate = release(root, 'release-two')
    pointCurrent(root, previous)
    unlinkSync(join(candidate, missing))
    const envFile = environmentFile(root)
    const state = join(root, 'state')
    const bin = fakeTools(root, state)
    writeFileSync(join(state, 'pid'), '100\n')
    writeFileSync(join(state, 'cwd'), `${realpathSync(previous)}/gateway\n`)

    const result = spawnSync('/bin/bash', [control, 'activate', candidate], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_STATE: state,
        HGW_GATEWAY_ENV_FILE: envFile,
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(missing.startsWith('packages/session/')
      ? 'release has no complete compiled Gateway payload' : 'release resource admission payload is missing or empty')
    expect(realpathSync(join(root, 'current'))).toBe(realpathSync(previous))
    expect(existsSync(join(root, '.activation.lock'))).toBe(false)
  })

  it.each([
    ...hostNativePaths().slice(0, 1),
    'native/system/packages/entry/lib/index.js',
    'native/system/packages/entry/lib/flock.js',
  ])('rejects a compiled release missing native payload %s before switching current', (missing) => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-release-native-'))
    const previous = release(root, 'release-one')
    const candidate = release(root, 'release-two')
    pointCurrent(root, previous)
    unlinkSync(join(candidate, missing))
    const envFile = environmentFile(root)
    const state = join(root, 'state')
    const bin = fakeTools(root, state)
    writeFileSync(join(state, 'pid'), '100\n')
    writeFileSync(join(state, 'cwd'), `${realpathSync(previous)}/gateway\n`)

    const result = spawnSync('/bin/bash', [control, 'activate', candidate], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_STATE: state,
        HGW_GATEWAY_ENV_FILE: envFile,
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`release payload is missing or empty`)
    expect(result.stderr).toContain(missing)
    expect(realpathSync(join(root, 'current'))).toBe(realpathSync(previous))
    expect(existsSync(join(root, '.activation.lock'))).toBe(false)
  })

  it('accepts an older compiled Gateway whose API does not import the resource coordinator', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-release-prior-resource-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const previous = release(root, 'release-one')
    writeFileSync(join(previous, 'gateway/lib/runtime-api.js'), 'previous API\n')
    for (const missing of ['gateway/lib/runtime-resource-api.js', 'gateway/lib/node-resource-budget.js',
      'gateway/lib/node-resource-pressure.js', 'packages/context/resource-budget/lib/wire.js',
      'gateway/node_modules/@deepseek-ai/dsh-resource-budget/package.json']) unlinkSync(join(previous, missing))
    pointCurrent(root, previous)
    const capture = join(root, 'capture')
    const fakeNode = join(root, 'fake-node')
    executable(fakeNode, '#!/bin/bash\nprintf "%s\\n" "$*" > "$CAPTURE"\n')
    const envFile = environmentFile(root, fakeNode)
    const result = spawnSync('/bin/bash', [control, 'run'], { encoding: 'utf8',
      env: { ...process.env, CAPTURE: capture, HGW_GATEWAY_ENV_FILE: envFile } })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(capture, 'utf8')).toBe(`${realpathSync(previous)}/gateway/lib/index.js\n`)
  })

  it.each([null, 'gateway/lib/runtime-document-store.js',
    'packages/attachment/userdoc-gateway/lib/protocol.js', 'packages/attachment/userdoc-gateway/lib/protocol-core.js',
    'packages/util/values/lib/index.js', 'empty-protocol', 'wrong-export',
  ])('validates the compiled document module graph before running a release with defect %s', (defect) => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-release-documents-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const candidate = release(root, 'release-documents')
    writeFileSync(join(candidate, 'gateway/package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(join(candidate, 'gateway/lib/index.js'), 'export {}\n')
    writeFileSync(join(candidate, 'gateway/lib/runtime-api.js'), "export { value } from './runtime-document-store.js'\n")
    writeFileSync(join(candidate, 'gateway/lib/runtime-document-store.js'),
      'export { value } from "@deepseek-ai/dsh-userdoc-gateway/protocol"\nexport { assertNever } from "@deepseek-ai/dsh-util-values"\n')
    for (const [directory, name, exports] of [
      ['packages/attachment/userdoc-gateway', '@deepseek-ai/dsh-userdoc-gateway', { './protocol': './lib/protocol.js' }],
      ['packages/util/values', '@deepseek-ai/dsh-util-values', { '.': './lib/index.js' }],
    ] as const) {
      const packageRoot = join(candidate, directory), link = join(candidate, 'gateway/node_modules', name)
      mkdirSync(join(packageRoot, 'lib'), { recursive: true })
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name, type: 'module', exports }))
      symlinkSync(relative(dirname(link), packageRoot), link, 'dir')
    }
    writeFileSync(join(candidate, 'packages/attachment/userdoc-gateway/lib/protocol.js'), "export { value } from './protocol-core.js'\n")
    writeFileSync(join(candidate, 'packages/attachment/userdoc-gateway/lib/protocol-core.js'), 'export const value = 1\n')
    writeFileSync(join(candidate, 'packages/util/values/lib/index.js'), 'export function assertNever() { throw new Error("unreachable") }\n')
    if (defect === 'empty-protocol') writeFileSync(join(candidate, 'packages/attachment/userdoc-gateway/lib/protocol.js'), '')
    else if (defect === 'wrong-export') {
      writeFileSync(join(candidate, 'packages/attachment/userdoc-gateway/package.json'), JSON.stringify({ type: 'module', exports: {} }))
    } else if (defect !== null) unlinkSync(join(candidate, defect))
    pointCurrent(root, candidate)
    const result = spawnSync('/bin/bash', [control, 'run'], { encoding: 'utf8',
      env: { ...process.env, HGW_GATEWAY_ENV_FILE: environmentFile(root) } })
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(defect === null ? 0 : 1)
    if (defect !== null) expect(result.stderr).toMatch(/release document (payload|module graph)/)
  })

  it.each([null, 'prior-material-receipts', 'prior-request-sessions', 'gateway/lib/gateway-model-budget.js', 'gateway/lib/postgres/progress-usage.js',
    'gateway/lib/postgres/progress-service.js',
    'native/system/packages/entry/lib/flock.js', 'gateway/node_modules/@deepseek-ai/node-addon-system/package.json',
    'gateway/deploy/postgres/migrations/065_gateway_model_ownership.sql',
    'gateway/deploy/postgres/migrations/066_project_journal_generation.sql',
    'gateway/deploy/postgres/migrations/067_project_journal_requests.sql',
    'gateway/deploy/postgres/migrations/068_project_journal_visibility.sql',
    'gateway/deploy/postgres/migrations/069_project_journal_materials.sql',
    'gateway/deploy/postgres/migrations/070_project_journal_request_sessions.sql',
    'gateway/deploy/postgres/migrations/071_project_journal_request_deletion.sql',
    'packages/core/session/lib/index.js', 'gateway/node_modules/@deepseek-ai/dsh-session/package.json',
  ])('checks the compiled Gateway model admission payload with absent file %s', missing => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-release-model-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const candidate = release(root, 'release-model')
    writeFileSync(join(candidate, 'gateway/lib/index.js'), "import './gateway-model-budget.js'\n")
    for (const file of ['gateway/lib/gateway-model-budget.js', 'gateway/lib/postgres/progress-usage.js',
      'gateway/lib/postgres/progress-service.js',
      'native/system/packages/entry/lib/flock.js', 'gateway/node_modules/@deepseek-ai/node-addon-system/package.json',
      'gateway/deploy/postgres/migrations/065_gateway_model_ownership.sql',
      'gateway/deploy/postgres/migrations/066_project_journal_generation.sql',
      'gateway/deploy/postgres/migrations/067_project_journal_requests.sql',
      'gateway/deploy/postgres/migrations/068_project_journal_visibility.sql',
      'gateway/deploy/postgres/migrations/069_project_journal_materials.sql',
      'gateway/deploy/postgres/migrations/070_project_journal_request_sessions.sql',
      'gateway/deploy/postgres/migrations/071_project_journal_request_deletion.sql',
      'packages/core/session/lib/index.js', 'gateway/node_modules/@deepseek-ai/dsh-session/package.json']) {
      mkdirSync(join(candidate, file, '..'), { recursive: true })
      writeFileSync(join(candidate, file), 'payload\n')
    }
    writeFileSync(join(candidate, 'gateway/lib/postgres/progress-service.js'), 'project_journal_materials\n')
    writeFileSync(join(candidate, 'gateway/lib/postgres/progress-usage.js'), 'request_session\n')
    if (missing === 'prior-material-receipts') {
      writeFileSync(join(candidate, 'gateway/lib/postgres/progress-service.js'), 'prior progress service\n')
      unlinkSync(join(candidate, 'gateway/deploy/postgres/migrations/069_project_journal_materials.sql'))
    }
    if (missing === 'prior-material-receipts' || missing === 'prior-request-sessions') {
      writeFileSync(join(candidate, 'gateway/lib/postgres/progress-usage.js'), 'prior progress evidence\n')
      for (const file of ['gateway/deploy/postgres/migrations/070_project_journal_request_sessions.sql',
        'gateway/deploy/postgres/migrations/071_project_journal_request_deletion.sql',
        'packages/core/session/lib/index.js', 'gateway/node_modules/@deepseek-ai/dsh-session/package.json']) unlinkSync(join(candidate, file))
    } else if (missing !== null) unlinkSync(join(candidate, missing))
    pointCurrent(root, candidate)
    const capture = join(root, 'capture'), fakeNode = join(root, 'fake-node')
    executable(fakeNode, '#!/bin/bash\nprintf "%s\\n" "$*" > "$CAPTURE"\n')
    const envFile = environmentFile(root, fakeNode)
    const result = spawnSync('/bin/bash', [control, 'run'], { encoding: 'utf8',
      env: { ...process.env, CAPTURE: capture, HGW_GATEWAY_ENV_FILE: envFile } })
    const accepted = missing === null || missing === 'prior-material-receipts' || missing === 'prior-request-sessions'
    expect(result.status, result.stderr).toBe(accepted ? 0 : 1)
    if (accepted) expect(readFileSync(capture, 'utf8')).toBe(`${realpathSync(candidate)}/gateway/lib/index.js\n`)
    else expect(result.stderr).toContain('release Gateway model admission payload is missing or empty')
  })

  it.each(['complete', 'missing-migration', 'prior-capture-bounds'] as const)('checks %s pressure-capture payloads', mode => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-release-pressure-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const candidate = release(root, 'pressure')
    writeFileSync(join(candidate, 'gateway/lib/node-resource-budget.js'), mode === 'prior-capture-bounds' ? 'prior budget\n' : 'sampled_before\n')
    if (mode === 'complete') {
      const migration = join(candidate, 'gateway/deploy/postgres/migrations/072_node_pressure_capture_bounds.sql')
      mkdirSync(dirname(migration), { recursive: true }); writeFileSync(migration, 'payload\n')
    }
    pointCurrent(root, candidate)
    const capture = join(root, 'capture'), fakeNode = join(root, 'fake-node')
    executable(fakeNode, '#!/bin/bash\nprintf "%s\\n" "$*" > "$CAPTURE"\n')
    const envFile = environmentFile(root, fakeNode)
    const result = spawnSync('/bin/bash', [control, 'run'], { encoding: 'utf8',
      env: { ...process.env, CAPTURE: capture, HGW_GATEWAY_ENV_FILE: envFile } })
    expect(result.status, result.stderr).toBe(mode === 'missing-migration' ? 1 : 0)
    if (mode === 'missing-migration') expect(result.stderr).toContain('release resource admission payload is missing or empty')
    else expect(readFileSync(capture, 'utf8')).toBe(`${realpathSync(candidate)}/gateway/lib/index.js\n`)
  })

  it.each((['project', 'model'] as const).flatMap(kind =>
    (['complete', 'missing-migration', 'prior-account-locks'] as const).map(mode => ({ kind, mode })),
  ))('checks $mode $kind account-deletion payloads', ({ kind, mode }) => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-release-account-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const candidate = release(root, 'account')
    const service = join(candidate, `gateway/lib/postgres/${kind === 'project' ? 'project' : 'model-governance'}-service.js`)
    mkdirSync(dirname(service), { recursive: true })
    writeFileSync(service, mode === 'prior-account-locks' ? 'prior project service\n' : 'mutationUser\n')
    if (mode === 'complete') {
      const migration = join(candidate, `gateway/deploy/postgres/migrations/${kind === 'project' ? '073_deleted_project' : '074_deleted_model'}_relationships.sql`)
      mkdirSync(dirname(migration), { recursive: true }); writeFileSync(migration, 'payload\n')
    }
    pointCurrent(root, candidate)
    const capture = join(root, 'capture'), fakeNode = join(root, 'fake-node')
    executable(fakeNode, '#!/bin/bash\nprintf "%s\\n" "$*" > "$CAPTURE"\n')
    const envFile = environmentFile(root, fakeNode)
    const result = spawnSync('/bin/bash', [control, 'run'], { encoding: 'utf8',
      env: { ...process.env, CAPTURE: capture, HGW_GATEWAY_ENV_FILE: envFile } })
    expect(result.status, result.stderr).toBe(mode === 'missing-migration' ? 1 : 0)
    if (mode === 'missing-migration') expect(result.stderr).toContain(`release ${kind} account deletion payload is missing or empty`)
    else expect(readFileSync(capture, 'utf8')).toBe(`${realpathSync(candidate)}/gateway/lib/index.js\n`)
  })

  it('rejects a compiled release missing the host native addon before switching current', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-release-native-'))
    const previous = release(root, 'release-one')
    const candidate = release(root, 'release-two')
    pointCurrent(root, previous)
    const missing = hostNativePaths()[0]
    expect(missing).toBeDefined()
    unlinkSync(join(candidate, missing as string))
    const envFile = environmentFile(root)
    const state = join(root, 'state')
    const bin = fakeTools(root, state)
    writeFileSync(join(state, 'pid'), '100\n')
    writeFileSync(join(state, 'cwd'), `${realpathSync(previous)}/gateway\n`)

    const result = spawnSync('/bin/bash', [control, 'activate', candidate], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_STATE: state,
        HGW_GATEWAY_ENV_FILE: envFile,
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`release payload is missing or empty`)
    expect(result.stderr).toContain(missing)
    expect(realpathSync(join(root, 'current'))).toBe(realpathSync(previous))
    expect(existsSync(join(root, '.activation.lock'))).toBe(false)
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

  it.each(['unknown flag', 'missing value', 'extra argument', 'duplicate flag'] as const)(
    'rejects %s before inspecting processes or switching current', kind => {
      const f = activationFixture()
      const args = kind === 'unknown flag' ? [f.candidate, '--fallback', f.fallback]
        : kind === 'missing value' ? [f.candidate, '--rollback-target']
          : kind === 'extra argument' ? [f.candidate, '--rollback-target', f.fallback, 'extra']
            : [f.candidate, '--rollback-target', f.fallback, '--rollback-target', f.previous]
      const result = f.activate(args)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('usage:')
      f.expectUnchanged()
    },
  )

  it.each(['missing', 'same', 'same via alias', 'current', 'current/.', 'outside', 'nested', 'incomplete', 'source-only'] as const)(
    'rejects a %s rollback target without changing the active release', kind => {
      const f = activationFixture()
      let target = f.fallback
      if (kind === 'missing') target = join(f.root, 'missing')
      if (kind === 'same') target = f.candidate
      if (kind === 'same via alias') {
        target = join(f.root, 'candidate-alias')
        symlinkSync(f.candidate, target)
      }
      if (kind === 'current' || kind === 'current/.') target = `${join(f.root, 'current')}${kind === 'current/.' ? '/.' : '/'}`
      if (kind === 'outside') {
        const outside = mkdtempSync(join(tmpdir(), 'hgw-release-outside-'))
        onTestFinished(() => rmSync(outside, { recursive: true, force: true }))
        target = release(outside, 'release-outside')
      }
      if (kind === 'nested') target = release(join(f.root, 'nested'), 'release-nested')
      if (kind === 'incomplete' || kind === 'source-only') unlinkSync(join(target, 'gateway/lib/index.js'))
      if (kind === 'source-only') {
        mkdirSync(join(target, 'gateway/src'), { recursive: true })
        mkdirSync(join(target, 'gateway/node_modules/tsx'), { recursive: true })
        writeFileSync(join(target, 'gateway/src/index.ts'), 'fixture\n')
        writeFileSync(join(target, 'gateway/node_modules/tsx/package.json'), 'fixture\n')
      }
      const result = f.activate([f.candidate, '--rollback-target', target])
      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain('usage:')
      f.expectUnchanged()
    },
  )

  it('validates the candidate before any process operation with a complete fallback selected', () => {
    const f = activationFixture()
    unlinkSync(join(f.candidate, 'gateway/lib/runtime-api.js'))
    const result = f.activate([f.candidate, '--rollback-target', f.fallback])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('release has no complete compiled Gateway payload')
    f.expectUnchanged()
  })

  it('keeps the selected fallback inactive when the candidate becomes healthy', () => {
    const f = activationFixture()
    const result = f.activate([f.candidate, '--rollback-target', f.fallback])
    expect(result.status, result.stderr).toBe(0)
    expect(realpathSync(join(f.root, 'current'))).toBe(realpathSync(f.candidate))
    expect(readFileSync(join(f.state, 'started'), 'utf8')).toBe('release-candidate\n')
    expect(f.actions()).toContain('kill -TERM 910001\n')
    expect(f.actions()).not.toContain('kill -TERM 910002\n')
  })

  it('restores only the explicitly selected release after candidate health fails', () => {
    const f = activationFixture()
    const result = f.activate([f.candidate, '--rollback-target', f.fallback], { FAKE_FAIL_RELEASE: 'release-candidate' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('failed health verification; restored release-compatible')
    expect(realpathSync(join(f.root, 'current'))).toBe(realpathSync(f.fallback))
    expect(readFileSync(join(f.state, 'started'), 'utf8')).toBe('release-candidate\nrelease-compatible\n')
    expect(f.actions()).toContain('kill -TERM 910001\n')
    expect(f.actions()).not.toContain('kill -TERM 910002\n')
  })

  it.each(['unhealthy', 'wrong release identity'] as const)(
    'reports a %s fallback without enabling the original previous release', kind => {
      const f = activationFixture()
      const result = f.activate([f.candidate, '--rollback-target', f.fallback], {
        FAKE_FAIL_RELEASE: 'release-candidate',
        ...(kind === 'unhealthy' ? { FAKE_FAIL_ROLLBACK_RELEASE: 'release-compatible' }
          : { FAKE_HEALTH_RELEASE: 'release-previous' }),
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('rollback release-compatible did not become healthy')
      expect(realpathSync(join(f.root, 'current'))).toBe(realpathSync(f.fallback))
      expect(readFileSync(join(f.state, 'started'), 'utf8')).toBe('release-candidate\nrelease-compatible\n')
      expect(existsSync(join(f.root, '.activation.lock'))).toBe(false)
    },
  )

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
