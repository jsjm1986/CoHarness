/** Fixture-owned Gateway state; production defaults remain covered by config.spec.ts. */
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { loadConfig, type GatewayConfig } from '../src/config.ts'

/**
 * Build an explicit environment whose writable locations belong to one fixture.
 * Source packages and migration inputs retain their real read-only locations.
 * @param root - absolute temporary directory owned by the caller.
 * @param overrides - explicit fixture settings, never an inherited production environment.
 * @returns an environment suitable for both loadConfig and a fixture subprocess.
 */
export function testEnvironment(root: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  if (!isAbsolute(root)) throw new Error('Gateway fixture root must be absolute')
  const projects = overrides.HGW_PROJECT_PATH_ROOTS?.split(',')[0]?.trim() || root
  const env = {
    HGW_USERS_ROOT: join(root, 'users'),
    HGW_PROJECT_RUNTIMES_ROOT: join(root, 'project-runtimes'),
    HGW_PROJECTS_ROOT: join(projects, 'projects'),
    HGW_USER_PROJECTS_ROOT: join(projects, 'user-projects'),
    HGW_STATE_ROOT: join(root, 'state'),
    HGW_SYSTEMD_UNIT_DIR: join(root, 'systemd-units'),
    HGW_DEFAULT_ENV_FILE: '',
    ...overrides,
  }
  const cfg = loadConfig(env)
  const writable = {
    usersRoot: cfg.usersRoot, projectRuntimesRoot: cfg.projectRuntimesRoot,
    projectsRoot: cfg.projectsRoot, userProjectsRoot: cfg.userProjectsRoot,
    stateRoot: cfg.stateRoot, principalKeyDir: cfg.principalKeyDir,
    runtimeCredentialDir: cfg.runtimeCredentialDir, systemdUnitDir: cfg.systemdUnitDir,
    organizationModelCredentialKeyFile: cfg.organizationModelCredentialKeyFile,
    webhookSecretKeyFile: cfg.webhookSecretKeyFile, bootstrapAdminPasswordFile: cfg.bootstrapAdminPasswordFile,
    backupDir: cfg.backupDir, nodeConfigFile: cfg.nodeConfigFile,
    databaseUrlFile: cfg.databaseUrlFile, managedDataApprovalFile: cfg.managedDataApprovalFile,
  }
  for (const [name, path] of Object.entries(writable)) {
    if (path === undefined) continue
    const fromRoot = relative(resolve(root), resolve(path))
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`Gateway fixture ${name} escapes its owned temporary directory`)
    }
  }
  return env
}

/**
 * Parse the real Gateway config with fixture-owned writable defaults.
 * @param root - absolute temporary directory owned by the caller.
 * @param overrides - explicit fixture settings.
 * @returns validated Gateway configuration without production state locations.
 */
export function testConfig(root: string, overrides: NodeJS.ProcessEnv = {}): GatewayConfig {
  return loadConfig(testEnvironment(root, overrides))
}
