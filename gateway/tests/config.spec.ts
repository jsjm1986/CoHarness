import { realpathSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DATABASE_STARTUP_RETRY_INITIAL_MS,
  DEFAULT_DATABASE_STARTUP_RETRY_MAX_MS,
  DEFAULT_RUNTIME_API_BODY_LIMIT_BYTES,
  loadConfig,
} from '../src/config.ts'

describe('loadConfig', () => {
  it('provides workable defaults', () => {
    const cfg = loadConfig({})
    expect(cfg.port).toBe(8899)
    expect(cfg.instancePortBase).toBe(42000)
    expect(cfg.publicOrigins).toEqual(['http://127.0.0.1:8899'])
    expect(cfg.secureCookies).toBe(false)
    expect(cfg.dshCommand).toContain('{port}')
    expect(cfg.runtimeApiBodyLimitBytes).toBe(DEFAULT_RUNTIME_API_BODY_LIMIT_BYTES)
    expect(cfg.databaseStartupRetryInitialMs).toBe(DEFAULT_DATABASE_STARTUP_RETRY_INITIAL_MS)
    expect(cfg.databaseStartupRetryMaxMs).toBe(DEFAULT_DATABASE_STARTUP_RETRY_MAX_MS)
    expect(cfg.projectPathRoots).toEqual([])
    expect(cfg.userProjectsRoot).toMatch(/user-projects$/)
    expect(cfg.projectsRoot).toMatch(/harness-projects$/)
    // The default CLI entry must be an ABSOLUTE path (resolved against
    // dshRepoRoot), because instances spawn with cwd = user home.
    const bin = cfg.dshCommand.find(arg => arg.endsWith('apps/cli/src/bin.ts'))
    expect(bin).toBeDefined()
    expect(isAbsolute(bin as string)).toBe(true)
  })

  it('resolves the default CLI entry against HGW_DSH_REPO_ROOT', () => {
    const cfg = loadConfig({ HGW_DSH_REPO_ROOT: '/opt/harness' })
    expect(cfg.dshCommand).toContain('/opt/harness/apps/cli/src/bin.ts')
  })

  it('pins every release-owned path to one canonical immutable release', () => {
    const releaseRoot = realpathSync(resolve(import.meta.dirname, '../..'))
    const cfg = loadConfig({ HGW_RELEASE_ROOT: releaseRoot })

    expect(cfg.releaseRoot).toBe(releaseRoot)
    expect(cfg.releaseId).toBe(basename(releaseRoot))
    expect(cfg.dshRepoRoot).toBe(releaseRoot)
    expect(cfg.gatewayDir).toBe(join(releaseRoot, 'gateway'))
    expect(cfg.dshCommand).toEqual([
      process.execPath,
      join(releaseRoot, 'apps/cli/lib/bin.js'),
      'web',
      '--port',
      '{port}',
    ])
    expect(cfg.guardPatch).toBe(join(releaseRoot, 'plugins/dsh-directory-guard/cordis.patch.yml'))
    expect(cfg.modelGovernancePackage).toBe(join(releaseRoot, 'plugins/dsh-model-governance'))
  })

  it('rejects independently configured runtime paths in release mode', () => {
    const releaseRoot = realpathSync(resolve(import.meta.dirname, '../..'))

    expect(() => loadConfig({ HGW_RELEASE_ROOT: releaseRoot, HGW_DSH_COMMAND: 'node somewhere-else.js' }))
      .toThrow(/HGW_DSH_COMMAND must be unset/)
    expect(() => loadConfig({ HGW_RELEASE_ROOT: releaseRoot, HGW_DSH_REPO_ROOT: '/tmp' }))
      .toThrow(/HGW_DSH_REPO_ROOT must resolve inside/)
    expect(() => loadConfig({ HGW_RELEASE_ROOT: releaseRoot, HGW_GATEWAY_DIR: '/tmp' }))
      .toThrow(/HGW_GATEWAY_DIR must resolve inside/)
    expect(() => loadConfig({ HGW_RELEASE_ROOT: releaseRoot, HGW_MODEL_GOVERNANCE_PACKAGE: '/tmp' }))
      .toThrow(/HGW_MODEL_GOVERNANCE_PACKAGE must resolve inside/)
  })

  it('resolves the tsx loader to an absolute file for the real repo (instances spawn outside it)', () => {
    const cfg = loadConfig({})
    const importIndex = cfg.dshCommand.indexOf('--import')
    const loader = cfg.dshCommand[importIndex + 1] as string
    expect(isAbsolute(loader)).toBe(true)
    expect(loader).toMatch(/tsx.*esm.*\.mjs$/)
  })

  it('derives the directory-guard patch from the repo root, honors overrides, and accepts off', () => {
    expect(loadConfig({ HGW_DSH_REPO_ROOT: '/opt/harness' }).guardPatch)
      .toBe('/opt/harness/plugins/dsh-directory-guard/cordis.patch.yml')
    expect(loadConfig({ HGW_GUARD_PATCH: '/x/guard.yml' }).guardPatch).toBe('/x/guard.yml')
    expect(loadConfig({ HGW_GUARD_PATCH: 'off' }).guardPatch).toBe('')
  })

  it('honors HGW_ environment overrides', () => {
    const cfg = loadConfig({
      HGW_PORT: '9001',
      HGW_ORGANIZATION_SLUG: 'internal',
      HGW_COMPUTE_NODE_NAME: 'mac-mini',
      HGW_PUBLIC_ORIGINS: 'https://harness.maycran.com,http://127.0.0.1:9001',
      HGW_USERS_ROOT: '/srv/harness/users',
      HGW_USER_PROJECTS_ROOT: '/srv/harness/projects/user-projects',
      HGW_PROJECTS_ROOT: '/srv/harness/projects/admin',
      HGW_IDLE_TIMEOUT_MS: '60000',
      HGW_RUNTIME_API_BODY_LIMIT_BYTES: '8388608',
      HGW_DATABASE_STARTUP_RETRY_INITIAL_MS: '250',
      HGW_DATABASE_STARTUP_RETRY_MAX_MS: '5000',
      HGW_FCM_PROJECT_ID: '  firebase-project  ',
      HGW_FCM_SERVICE_ACCOUNT_FILE: '  /srv/harness/firebase.json  ',
      HGW_JPUSH_APP_KEY: '  jpush-app-key  ',
      HGW_JPUSH_MASTER_SECRET: '  jpush-master-secret  ',
    })
    expect(cfg.port).toBe(9001)
    expect(cfg.organizationSlug).toBe('internal')
    expect(cfg.computeNodeName).toBe('mac-mini')
    expect(cfg.publicOrigins).toEqual(['https://harness.maycran.com', 'http://127.0.0.1:9001'])
    expect(cfg.usersRoot).toBe('/srv/harness/users')
    expect(cfg.userProjectsRoot).toBe('/srv/harness/projects/user-projects')
    expect(cfg.projectsRoot).toBe('/srv/harness/projects/admin')
    expect(cfg.idleTimeoutMs).toBe(60000)
    expect(cfg.runtimeApiBodyLimitBytes).toBe(8 * 1024 * 1024)
    expect(cfg.databaseStartupRetryInitialMs).toBe(250)
    expect(cfg.databaseStartupRetryMaxMs).toBe(5000)
    expect(cfg.fcmProjectId).toBe('firebase-project')
    expect(cfg.fcmServiceAccountFile).toBe('/srv/harness/firebase.json')
    expect(cfg.jpushAppKey).toBe('jpush-app-key')
    expect(cfg.jpushMasterSecret).toBe('jpush-master-secret')
    expect(cfg.secureCookies).toBe(true)
  })

  it('requires both JPush credentials when JPush delivery is enabled', () => {
    expect(() => loadConfig({ HGW_JPUSH_APP_KEY: 'app-key' }))
      .toThrow(/HGW_JPUSH_APP_KEY and HGW_JPUSH_MASTER_SECRET/)
    expect(() => loadConfig({ HGW_JPUSH_MASTER_SECRET: 'master-secret' }))
      .toThrow(/HGW_JPUSH_APP_KEY and HGW_JPUSH_MASTER_SECRET/)
  })

  it('rejects a project runtime account that systemd cannot address', () => {
    expect(() => loadConfig({ HGW_PROJECT_RUNTIME_USER: 'Project Runtime' }))
      .toThrow(/HGW_PROJECT_RUNTIME_USER/)
    expect(() => loadConfig({ HGW_PROJECT_RUNTIME_USER: `harness-${'x'.repeat(40)}` }))
      .toThrow(/HGW_PROJECT_RUNTIME_USER/)
    expect(() => loadConfig({ HGW_PROJECT_RUNTIME_USER: 'root' }))
      .toThrow(/HGW_PROJECT_RUNTIME_USER/)
  })

  it('requires non-overlapping project path roots for the systemd launcher', () => {
    expect(() => loadConfig({ HGW_LAUNCHER: 'systemd' })).toThrow(/HGW_PROJECT_PATH_ROOTS/)
    expect(loadConfig({ HGW_LAUNCHER: 'systemd', HGW_PROJECT_PATH_ROOTS: '/srv/projects,/mnt/projects' })
      .projectPathRoots).toEqual(['/srv/projects', '/mnt/projects'])
    expect(() => loadConfig({ HGW_PROJECT_PATH_ROOTS: '/srv/projects,/srv/projects/team' }))
      .toThrow(/overlapping roots/)
    expect(() => loadConfig({ HGW_PROJECT_PATH_ROOTS: '/' })).toThrow(/filesystem root/)
  })

  it('keeps managed user projects inside a data root and away from reserved paths', () => {
    expect(loadConfig({
      HGW_LAUNCHER: 'systemd', HGW_PROJECT_PATH_ROOTS: '/srv/projects',
      HGW_USER_PROJECTS_ROOT: '/srv/projects/managed/',
    }).userProjectsRoot).toBe('/srv/projects/managed')
    expect(() => loadConfig({ HGW_LAUNCHER: 'systemd', HGW_PROJECT_PATH_ROOTS: '/srv/projects' }))
      .not.toThrow()
    expect(() => loadConfig({ HGW_USER_PROJECTS_ROOT: 'relative/projects' }))
      .toThrow(/HGW_USER_PROJECTS_ROOT/)
    expect(() => loadConfig({
      HGW_LAUNCHER: 'systemd', HGW_PROJECT_PATH_ROOTS: '/srv/projects', HGW_USER_PROJECTS_ROOT: '/srv/projects',
    })).toThrow(/strict descendant/)
    expect(() => loadConfig({
      HGW_USER_PROJECTS_ROOT: '/tmp', HGW_USERS_ROOT: '/tmp/users',
    })).toThrow(/reserved Gateway directory/)
  })

  it('keeps the managed admin project root isolated and away from reserved paths', () => {
    expect(loadConfig({
      HGW_LAUNCHER: 'systemd', HGW_PROJECT_PATH_ROOTS: '/srv/projects',
      HGW_PROJECTS_ROOT: '/srv/projects/admin/',
    }).projectsRoot).toBe('/srv/projects/admin')
    expect(() => loadConfig({ HGW_PROJECTS_ROOT: 'relative/projects' }))
      .toThrow(/HGW_PROJECTS_ROOT/)
    expect(() => loadConfig({
      HGW_LAUNCHER: 'systemd', HGW_PROJECT_PATH_ROOTS: '/srv/projects', HGW_PROJECTS_ROOT: '/srv/projects',
    })).toThrow(/strict descendant/)
    expect(() => loadConfig({
      HGW_PROJECTS_ROOT: '/tmp', HGW_USERS_ROOT: '/tmp/users',
    })).toThrow(/reserved Gateway directory/)
    expect(() => loadConfig({
      HGW_PROJECTS_ROOT: '/srv/projects', HGW_USER_PROJECTS_ROOT: '/srv/projects/managed',
    })).toThrow(/reserved Gateway directory/)
  })

  it('rejects an invalid runtime API body limit', () => {
    expect(() => loadConfig({ HGW_RUNTIME_API_BODY_LIMIT_BYTES: '0' }))
      .toThrow(/positive safe integer/)
    expect(() => loadConfig({ HGW_RUNTIME_API_BODY_LIMIT_BYTES: 'not-a-number' }))
      .toThrow(/positive safe integer/)
  })

  it('rejects invalid database startup retry windows', () => {
    expect(() => loadConfig({ HGW_DATABASE_STARTUP_RETRY_INITIAL_MS: '0' }))
      .toThrow(/HGW_DATABASE_STARTUP_RETRY_INITIAL_MS/)
    expect(() => loadConfig({ HGW_DATABASE_STARTUP_RETRY_MAX_MS: 'not-a-number' }))
      .toThrow(/HGW_DATABASE_STARTUP_RETRY_MAX_MS/)
    expect(() => loadConfig({
      HGW_DATABASE_STARTUP_RETRY_INITIAL_MS: '5000',
      HGW_DATABASE_STARTUP_RETRY_MAX_MS: '1000',
    })).toThrow(/HGW_DATABASE_STARTUP_RETRY_MAX_MS must be at least/)
  })

  it('rejects an invalid instance port base', () => {
    expect(() => loadConfig({ HGW_INSTANCE_PORT_BASE: '1023' })).toThrow(/HGW_INSTANCE_PORT_BASE/)
    expect(() => loadConfig({ HGW_INSTANCE_PORT_BASE: '65536' })).toThrow(/HGW_INSTANCE_PORT_BASE/)
    expect(() => loadConfig({ HGW_INSTANCE_PORT_BASE: 'not-a-number' })).toThrow(/HGW_INSTANCE_PORT_BASE/)
  })
})
