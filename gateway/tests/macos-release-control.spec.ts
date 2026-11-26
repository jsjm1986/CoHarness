import {
  appendFileSync,
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
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createPostgresPool, runMigrations, verifyReleaseMigrationLedger } from '../src/postgres/database.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

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
    'gateway/deploy/windows/node-agent-task.ps1',
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
  writeFileSync(join(directory, 'gateway/lib/release-schema-check.js'), `
    const { basename, join } = require('node:path');
    const { appendFileSync } = require('node:fs');
    const [mode, candidate, selected] = process.argv.slice(2);
    const state = process.env.FAKE_STATE;
    if (state) appendFileSync(join(state, 'actions'), 'schema ' + mode + ' ' + basename(selected) + '\\n');
    if (basename(selected) === process.env.FAKE_REJECT_SCHEMA) {
      console.error('fixture rejects database schema');
      process.exit(1);
    }
  `)
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
  enable|disable) ;;
  print)
    if [[ "$2" == *-config ]]; then [[ "\${FAKE_CONFIG_APPLIER:-}" == 1 ]] || exit 1; fi
    current="$(cd "$HGW_RELEASES_ROOT/current" && pwd -P)"
    if [[ "\${FAKE_EXIT_RELEASE:-}" == "$(basename "$current")" ]]; then exit 0; fi
    if [[ "\${FAKE_REAL_LAUNCH:-}" == 1 && -s "$FAKE_STATE/pid" ]]; then
      /bin/kill -0 "$(cat "$FAKE_STATE/pid")" 2>/dev/null || exit 0
    fi
    if [[ -s "$FAKE_STATE/pid" ]]; then printf 'pid = %s\\n' "$(cat "$FAKE_STATE/pid")"; fi
    ;;
  kickstart)
    if [[ "\${3:-$2}" == *-config ]]; then printf 'restarted\\n' > "$FAKE_STATE/config-applier"; exit 0; fi
    if [[ "\${FAKE_REAL_LAUNCH:-}" == 1 ]]; then
      current="$(cd "$HGW_RELEASES_ROOT/current" && pwd -P)"
      basename "$current" >> "$FAKE_STATE/started"
      printf '%s\\n' "$current/gateway" > "$FAKE_STATE/cwd"
      if [[ "$(basename "$current")" == 'release-candidate' ]]; then
        "$FAKE_CONTROL" run </dev/null >> "$FAKE_STATE/gateway.log" 2>&1
      else
        "$FAKE_CONTROL" run </dev/null >> "$FAKE_STATE/gateway.log" 2>&1 &
        printf '%s\\n' "$!" > "$FAKE_STATE/pid"
      fi
      exit
    fi
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
  writeFileSync(join(state, 'pid'), '')
  writeFileSync(join(state, 'cwd'), `${realpathSync(previous)}/gateway\n`)
  writeFileSync(join(state, 'processes'), '')
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
    FAKE_EXIT_RELEASE: '',
    FAKE_REJECT_SCHEMA: '',
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
    expect(readFileSync(join(state, 'pid'), 'utf8')).toBe('')
    expect(actions()).toBe('')
    expect(existsSync(join(root, '.activation.lock'))).toBe(false)
  }
  return { root, previous, candidate, fallback, state, bin, env, activate, actions, expectUnchanged }
}

const macos = describe.skipIf(process.platform !== 'darwin')

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
it.skipIf(databaseUrl === undefined).each(['compatible', 'older', 'older-content', 'legacy-source'] as const)(
  'examines a committed PostgreSQL migration before selecting a %s fallback', async kind => {
    const f = activationFixture()
    const admin = createPostgresPool(databaseUrl!, { max: 1 })
    const database = 'hgw_release_' + randomUUID().replaceAll('-', '') + '_test'
    const contentDatabase = database + '_content'
    const url = new URL(databaseUrl!)
    url.pathname = '/' + database
    let pool: ReturnType<typeof createPostgresPool> | undefined
    let contentPool: ReturnType<typeof createPostgresPool> | undefined
    let created = false
    let contentCreated = false
    try {
      await admin.query(`CREATE DATABASE "${database}"`)
      created = true
      pool = createPostgresPool(url.href, { max: 1 })
      const credential = join(f.root, 'database-url')
      writeFileSync(credential, url.href, { mode: 0o600 })
      appendFileSync(f.env.HGW_GATEWAY_ENV_FILE, `HGW_DATABASE_URL_FILE=${shellValue(credential)}\n`)
      const contentMigrations = 'gateway/deploy/node-content/migrations'
      const contentFiles = [
        ['001_content.sql', 'CREATE TABLE node_content.fixture(id integer PRIMARY KEY);\n'],
        ['002_generation.sql', 'ALTER TABLE node_content.fixture ADD COLUMN generation integer NOT NULL DEFAULT 7;\n'],
      ] as const
      if (kind === 'older-content') {
        await admin.query(`CREATE DATABASE "${contentDatabase}"`)
        contentCreated = true
        const contentUrl = new URL(url.href)
        contentUrl.pathname = '/' + contentDatabase
        contentPool = createPostgresPool(contentUrl.href, { max: 1 })
        const volumeId = randomUUID(), privateFile = join(f.root, 'content-url')
        writeFileSync(privateFile, contentUrl.href, { mode: 0o600 })
        appendFileSync(f.env.HGW_GATEWAY_ENV_FILE, [
          `HGW_NODE_CONTENT_DATABASE_URL_FILE=${shellValue(privateFile)}`,
          `HGW_NODE_CONTENT_VOLUME_ID=${shellValue(volumeId)}`,
          `HGW_NODE_CONTENT_PGDATA=${shellValue(f.root)}`,
          '',
        ].join('\n'))
        await contentPool.query(`CREATE SCHEMA node_content;
          CREATE TABLE node_content.schema_migrations(version integer PRIMARY KEY,name text NOT NULL,checksum text NOT NULL);
          CREATE TABLE node_content.volume(singleton boolean PRIMARY KEY,volume_id uuid NOT NULL,database_oid oid NOT NULL);`)
        await contentPool.query(`INSERT INTO node_content.volume SELECT true,$1,oid FROM pg_database WHERE datname=current_database()`,[volumeId])
        for (const [index, [name, sql]] of contentFiles.entries()) {
          await contentPool.query(sql)
          await contentPool.query('INSERT INTO node_content.schema_migrations VALUES($1,$2,$3)',
            [index + 1, name, createHash('sha256').update(sql).digest('hex')])
        }
      }
      const sources = new URL('../src/', import.meta.url)
      const check = new URL('release-schema-check.ts', sources).href
      const migrations = 'gateway/deploy/postgres/migrations'
      for (const target of [f.previous, f.candidate, f.fallback]) {
        mkdirSync(join(target, migrations), { recursive: true })
        writeFileSync(join(target, migrations, '001_seed.sql'),
          "CREATE TABLE harness.release_fixture(value text NOT NULL); INSERT INTO harness.release_fixture VALUES('kept');\n")
        if (target === f.candidate || kind !== 'older' && target === f.fallback) {
          writeFileSync(join(target, migrations, '002_generation.sql'),
            'ALTER TABLE harness.release_fixture ADD COLUMN generation integer NOT NULL DEFAULT 7;\n')
        }
        writeFileSync(join(target, 'gateway/package.json'), '{"type":"module"}\n')
        mkdirSync(join(target, 'gateway/lib/postgres'), { recursive: true })
        writeFileSync(join(target, 'gateway/lib/postgres/database.js'),
          `export { databaseUrlFromFile } from ${JSON.stringify(new URL('postgres/database.ts', sources).href)};\n`)
        writeFileSync(join(target, 'gateway/lib/config.js'), `
          export function loadConfig(env) {
            const content = env.HGW_NODE_CONTENT_DATABASE_URL_FILE;
            return { organizationSlug:'fixture', computeNodeName:'fixture',
              ...(content && {nodeContent:{databaseUrlFile:content,dataDirectory:env.HGW_NODE_CONTENT_PGDATA,volumeId:env.HGW_NODE_CONTENT_VOLUME_ID}}) };
          }
        `)
        if (kind === 'older-content') {
          mkdirSync(join(target, contentMigrations), { recursive: true })
          for (const [name, sql] of contentFiles.slice(0, target === f.fallback ? 1 : 2)) {
            writeFileSync(join(target, contentMigrations, name), sql)
          }
        }
        writeFileSync(join(target, 'gateway/lib/release-schema-check.js'), `
          import { fileURLToPath } from 'node:url';
          process.argv[1] = fileURLToPath(${JSON.stringify(check)});
          await import(${JSON.stringify(check)});
        `)
        writeFileSync(join(target, 'gateway/lib/index.js'), `
          import { createServer } from 'node:http';
          import { writeFileSync } from 'node:fs';
          import { basename, join } from 'node:path';
          import { createPostgresPool, databaseUrlFromFile, runMigrations } from ${JSON.stringify(new URL('postgres/database.ts', sources).href)};
          const release = basename(process.env.HGW_RELEASE_ROOT);
          const pool = createPostgresPool(await databaseUrlFromFile(), {max:1});
          await runMigrations(pool, join(import.meta.dirname, '../deploy/postgres/migrations'));
          const ledger = (await pool.query('SELECT * FROM harness.schema_migrations ORDER BY version')).rows;
          const data = (await pool.query('SELECT value, generation FROM harness.release_fixture')).rows;
          await pool.end();
          if (release === 'release-candidate') {
            writeFileSync(join(process.env.FAKE_STATE, 'migration-receipt'), JSON.stringify({ledger,data}));
            process.exit(70);
          }
          const server = createServer((req, res) => res.end(JSON.stringify({ok:true, release, data, cwd:process.cwd()})));
          process.on('SIGTERM', () => server.close(() => writeFileSync(join(process.env.FAKE_STATE,'closed'), '')));
          server.listen(0, '127.0.0.1', () => writeFileSync(join(process.env.FAKE_STATE,'address'), 'http://127.0.0.1:' + server.address().port));
        `)
      }
      unlinkSync(join(f.fallback, 'gateway/lib/release-schema-check.js'))
      if (kind === 'legacy-source') {
        mkdirSync(join(f.fallback,'gateway/src/postgres'),{recursive:true})
        for (const file of ['index','config','postgres/database']) {
          writeFileSync(join(f.fallback,'gateway/src',file+'.ts'),readFileSync(join(f.fallback,'gateway/lib',file+'.js')))
        }
        unlinkSync(join(f.fallback,'gateway/lib/index.js'))
        const tsx = dirname(fileURLToPath(import.meta.resolve('tsx/package.json')))
        symlinkSync(tsx,join(f.fallback,'gateway/node_modules/tsx'))
        pointCurrent(f.root,f.fallback)
      }
      if (kind === 'compatible') {
        expect(await verifyReleaseMigrationLedger(pool,join(f.candidate,migrations),false)).toBe(true)
        expect(await verifyReleaseMigrationLedger(pool,join(f.candidate,migrations),true)).toBe(false)
        expect((await pool.query("SELECT to_regclass('harness.schema_migrations') AS ledger")).rows[0]!.ledger).toBeNull()
      }
      await runMigrations(pool, join(f.previous, migrations))
      const curl = spawnSync('which', ['curl'], { encoding:'utf8' }).stdout.trim()
      expect(curl).toBeTruthy()
      executable(join(f.bin, 'curl'), `#!/bin/bash
[[ -s "$FAKE_STATE/address" ]] && exec ${shellValue(curl)} -fsS --max-time 2 "$(cat "$FAKE_STATE/address")/healthz"
exit 22
`)
      appendFileSync(f.env.HGW_GATEWAY_ENV_FILE, 'HGW_ACTIVATION_TIMEOUT_SECONDS=8\n')
      const real = { FAKE_REAL_LAUNCH: '1', FAKE_CONTROL: control, NODE_OPTIONS: `--import=${import.meta.resolve('tsx/esm')}`,
        TSX_TSCONFIG_PATH: fileURLToPath(new URL('../tsconfig.run.json', import.meta.url)), HGW_DATABASE_URL: undefined,
        HGW_NODE_CONTENT_DATABASE_URL_FILE: undefined, HGW_NODE_CONTENT_VOLUME_ID: undefined, HGW_NODE_CONTENT_PGDATA: undefined }
      const result = f.activate(kind === 'legacy-source' ? [f.candidate] : [f.candidate,'--rollback-target',f.fallback], real)
      const log = readFileSync(join(f.state, 'gateway.log'), 'utf8')
      const receipt = JSON.parse(readFileSync(join(f.state, 'migration-receipt'), 'utf8'))
      expect(result.status, log + result.stderr).toBe(1)
      expect(receipt.ledger.map((entry: {version:number}) => entry.version)).toEqual([1, 2])
      expect(receipt.data).toEqual([{ value:'kept', generation:7 }])
      expect((await pool.query('SELECT * FROM harness.schema_migrations ORDER BY version')).rows.map(row => JSON.parse(JSON.stringify(row)))).toEqual(receipt.ledger)
      expect((await pool.query('SELECT value, generation FROM harness.release_fixture')).rows).toEqual(receipt.data)
      if (kind === 'compatible' || kind === 'legacy-source') {
        expect(result.stderr).toContain('restored release-compatible')
        expect(realpathSync(join(f.root, 'current'))).toBe(realpathSync(f.fallback))
        const health = await fetch(readFileSync(join(f.state, 'address'), 'utf8') + '/healthz')
        expect(await health.json()).toEqual({ok:true,release:'release-compatible',data:receipt.data,cwd:realpathSync(join(f.fallback,'gateway'))})
      } else {
        expect(result.stderr).toContain(kind === 'older' ? 'governance migration ledger does not match the release'
          : 'node content migration ledger does not match the release')
        expect(result.stderr).toContain('rollback release-compatible refused')
        expect(realpathSync(join(f.root, 'current'))).toBe(realpathSync(f.candidate))
        expect(readFileSync(join(f.state, 'started'), 'utf8')).toBe('release-candidate\n')
        const direct = f.activate([f.fallback], real)
        expect(direct.stderr).toContain('activation refused because database schema compatibility')
        expect(realpathSync(join(f.root,'current'))).toBe(realpathSync(f.candidate))
      }
      const expected = readFileSync(new URL('./expected/macos-release-schema-rollback.jsonl', import.meta.url), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line)).find(row => row.fallback === kind)
      expect({
        fallback: kind,
        applied: receipt.ledger.map((row: { version: number }) => row.version),
        selected: basename(realpathSync(join(f.root, 'current'))),
        started: readFileSync(join(f.state, 'started'), 'utf8').trim().split('\n'),
        healthy: existsSync(join(f.state, 'address')),
        data: receipt.data,
      }).toEqual(expected)
    } finally {
      try {
        const pid = Number(readFileSync(join(f.state,'pid'),'utf8'))
        if (pid > 0) {
          try {
            process.kill(pid, 'SIGTERM')
            if (existsSync(join(f.state, 'address'))) {
              await expect.poll(() => existsSync(join(f.state, 'closed')), { timeout: 3000 }).toBe(true)
            }
          } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error }
        }
      } finally {
        try { await Promise.all([pool?.end(),contentPool?.end()]) } finally {
          try {
            if (contentCreated) await admin.query(`DROP DATABASE "${contentDatabase}" WITH (FORCE)`)
            if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
          } finally { await admin.end() }
        }
      }
    }
  }, 45_000,
)

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
    'gateway/node_modules/@deepseek-ai/node-addon-system/package.json',
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

  it.each([
    'gateway/lib/local-runtime-supervisor.js',
    'gateway/deploy/postgres/migrations/149_quiescent_node_resource_completion.sql',
  ])('rejects a release missing %s before process inspection', required => {
    const manifest = readFileSync(new URL('../deploy/required-release-files.txt', import.meta.url), 'utf8')
    expect(manifest.trimEnd().split('\n')).toContain(required)
    const f = activationFixture()
    writeFileSync(join(f.candidate, 'gateway/deploy/required-release-files.txt'), `${required}\n`)
    const result = f.activate([f.candidate])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(required)
    f.expectUnchanged()
  })

  it('requires the fingerprint manifest when the compiled launcher imports its reader', () => {
    const f = activationFixture()
    writeFileSync(join(f.candidate, 'gateway/lib/launch-stamp.js'), "import './runtime-dependency-fingerprint.js'\n")
    const result = f.activate([f.candidate])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('gateway/deploy/required-release-files.txt')
    f.expectUnchanged()
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
    writeFileSync(join(state, 'pid'), '')
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
    expect(activated.stdout).toContain('activated release release-two (pid 1)')

    pointCurrent(root, r1)
    writeFileSync(join(state, 'pid'), '')
    writeFileSync(join(state, 'cwd'), `${realpathSync(r1)}/gateway\n`)
    const failed = spawnSync('/bin/bash', [control, 'activate', r2], {
      encoding: 'utf8',
      env: { ...env, FAKE_FAIL_RELEASE: 'release-two', FAKE_EXIT_RELEASE: 'release-two' },
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
    expect(f.actions()).not.toMatch(/kill |kickstart -k(?!.*-config)/)
  })

  it('restores only the explicitly selected release after candidate health fails', () => {
    const f = activationFixture()
    const result = f.activate([f.candidate, '--rollback-target', f.fallback], { FAKE_FAIL_RELEASE: 'release-candidate', FAKE_EXIT_RELEASE: 'release-candidate' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('failed health verification; restored release-compatible')
    expect(realpathSync(join(f.root, 'current'))).toBe(realpathSync(f.fallback))
    expect(readFileSync(join(f.state, 'started'), 'utf8')).toBe('release-candidate\nrelease-compatible\n')
    expect(f.actions()).not.toMatch(/kill |kickstart -k(?!.*-config)/)
  })

  it('keeps the previous release available for rollback while activation checks health', async () => {
    const f = activationFixture()
    const waiting = join(f.state, 'checking-health')
    const resume = join(f.state, 'resume-health')
    executable(join(f.bin, 'curl'), `#!/bin/bash
set -euo pipefail
current="$(cd "$HGW_RELEASES_ROOT/current" && pwd -P)"
release="$(basename "$current")"
if [[ "$release" == 'release-candidate' ]]; then
  touch "$FAKE_STATE/checking-health"
  for attempt in {1..500}; do
    [[ ! -f "$FAKE_STATE/resume-health" ]] || exit 22
    sleep 0.02
  done
  exit 22
fi
printf '{"ok":true,"release":"%s"}\\n' "$release"
`)
    const child = spawn('/bin/bash', [control, 'activate', f.candidate], {
      stdio: ['ignore', 'ignore', 'pipe'], env: { ...f.env, FAKE_EXIT_RELEASE: 'release-candidate' },
    })
    let diagnostic = ''
    child.stderr.setEncoding('utf8').on('data', value => { diagnostic += value })
    const done = once(child, 'close')
    const prune = (directory: string) => spawnSync('/bin/bash', [control, 'prune', directory], {
      encoding: 'utf8', env: f.env, timeout: 5000,
    })
    try {
      await expect.poll(() => existsSync(waiting), { timeout: 5000 }).toBe(true)
      expect(realpathSync(join(f.root, 'current'))).toBe(realpathSync(f.candidate))
      const refused = prune(f.previous)
      expect(refused.status, refused.stderr).toBe(1)
      expect(refused.stderr).toContain('another release operation holds')
      expect(existsSync(f.previous)).toBe(true)
    } finally {
      writeFileSync(resume, '')
      await done
    }
    expect(await done).toEqual([1, null])
    expect(diagnostic).toContain('failed health verification; restored release-previous')
    expect(realpathSync(join(f.root, 'current'))).toBe(realpathSync(f.previous))
    const removed = prune(f.fallback)
    expect(removed.status, removed.stderr).toBe(0)
    expect(existsSync(f.fallback)).toBe(false)
  })

  it('refuses an incompatible fallback before switching current or starting it', () => {
    const f = activationFixture()
    const failed = f.activate([f.candidate, '--rollback-target', f.fallback], {
      FAKE_FAIL_RELEASE: 'release-candidate', FAKE_EXIT_RELEASE: 'release-candidate', FAKE_REJECT_SCHEMA: 'release-compatible',
    })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('rollback release-compatible refused because compatibility with the installed database schemas could not be proved')
    expect(realpathSync(join(f.root, 'current'))).toBe(realpathSync(f.candidate))
    expect(readFileSync(join(f.state, 'started'), 'utf8')).toBe('release-candidate\n')
    expect(f.actions()).toMatch(/launchctl disable [^\n]+\nschema rollback release-compatible/u)
    expect(f.actions()).not.toMatch(/kill |kickstart -k/u)
  })

  it('refuses explicit activation of an older incompatible release before selecting it', () => {
    const f = activationFixture()
    const failed = f.activate([f.candidate], { FAKE_REJECT_SCHEMA: 'release-candidate' })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('activation refused because database schema compatibility')
    expect(realpathSync(join(f.root, 'current'))).toBe(realpathSync(f.previous))
    expect(f.actions()).not.toMatch(/launchctl (enable|kickstart|disable)/u)
    expect(existsSync(join(f.state, 'started'))).toBe(false)
  })

  it.each(['unhealthy', 'wrong release identity'] as const)(
    'reports a %s fallback without enabling the original previous release', kind => {
      const f = activationFixture()
      const result = f.activate([f.candidate, '--rollback-target', f.fallback], {
        FAKE_FAIL_RELEASE: 'release-candidate',
        FAKE_EXIT_RELEASE: 'release-candidate',
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

  it.each(['gateway', 'orphan-runtime'] as const)('refuses activation with a live %s without signalling its real process', async kind => {
    const f = activationFixture(), marker = join(f.root, 'signals')
    const entry = join(f.previous, 'gateway/lib/local-runtime-supervisor-fixture.cjs')
    writeFileSync(entry, `const fs=require('node:fs'); process.on('SIGTERM',()=>fs.appendFileSync(process.argv[2],'TERM\\n')); process.send('ready'); setInterval(()=>{},1000)`)
    const child = spawn(process.execPath, [entry, marker], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const closed = once(child, 'close')
    onTestFinished(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await closed })
    await once(child, 'message')
    if (kind === 'gateway') writeFileSync(join(f.state, 'pid'), `${child.pid}\n`)
    else unlinkSync(join(f.bin, 'ps'))
    const result = f.activate([f.candidate])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no process was stopped')
    expect(realpathSync(join(f.root, 'current'))).toBe(realpathSync(f.previous))
    expect(f.actions()).not.toMatch(/kill |kickstart/)
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
    expect(existsSync(marker)).toBe(false)
    expect(() => process.kill(child.pid!, 0)).not.toThrow()
  })

  it('retains an unhealthy candidate that still owns a running Gateway instead of killing or rolling it back', () => {
    const f = activationFixture()
    const result = f.activate([f.candidate, '--rollback-target', f.fallback], { FAKE_FAIL_RELEASE: 'release-candidate' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('candidate retained because shutdown is not confirmed')
    expect(realpathSync(join(f.root, 'current'))).toBe(realpathSync(f.candidate))
    expect(readFileSync(join(f.state, 'started'), 'utf8')).toBe('release-candidate\n')
    expect(f.actions()).not.toMatch(/kill |kickstart -k/)
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
