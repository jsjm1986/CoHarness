/** Resource fixtures fail before any write can escape their owned temporary root. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { writeProjectModelGovernanceFile } from '../src/apply-model-governance.ts'
import type { GatewayModelGovernanceService } from '../src/services.ts'
import { testConfig, testEnvironment } from './test-config.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function ownedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hgw-fixture-isolation-'))
  roots.push(root)
  return root
}

it('projects project policies and home patches only inside the fixture runtime root', async () => {
  const root = await ownedRoot(), cfg = testConfig(root)
  const dsh = join(root, 'project-runtimes', '1', 'dsh')
  await mkdir(dsh, { recursive: true })
  const patch = join(dsh, 'cordis.patch.yml')
  await writeFile(patch, '- id: fixture\n# gateway-managed organization default: begin\n- id: agent-default-model\n  config:\n    provider: obsolete\n    model: obsolete\n# gateway-managed organization default: end\n')
  const governance = {
    policyForProject: async () => ({ version: 1, defaultAllowed: false, models: [], providers: [] }),
    issueIntakeToken: async () => 'fixture-token',
  } as unknown as GatewayModelGovernanceService
  const path = await writeProjectModelGovernanceFile(cfg, governance, { kind: 'project', id: 1, name: 'Fixture', path: join(root, 'project') })
  expect(path).toBe(join(dsh, 'model-governance.json'))
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1, intakeToken: 'fixture-token', userDeclaredAllowed: false })
  expect(await readFile(patch, 'utf8')).toBe('- id: fixture\n')
  expect(cfg.principalKeyDir).toBe(join(root, 'state', 'principal-keys'))
  expect(cfg.backupDir).toBe(join(root, 'state', 'backups'))
  expect(cfg.systemdUnitDir).toBe(join(root, 'systemd-units'))
})

it.each([
  'HGW_USERS_ROOT', 'HGW_PROJECT_RUNTIMES_ROOT', 'HGW_PROJECTS_ROOT', 'HGW_USER_PROJECTS_ROOT',
  'HGW_STATE_ROOT', 'HGW_PRINCIPAL_KEY_DIR', 'HGW_RUNTIME_CREDENTIAL_DIR', 'HGW_SYSTEMD_UNIT_DIR',
  'HGW_ORGANIZATION_MODEL_CREDENTIAL_KEY_FILE', 'HGW_WEBHOOK_SECRET_KEY_FILE', 'HGW_BOOTSTRAP_ADMIN_PASSWORD_FILE',
  'HGW_BACKUP_DIR', 'HGW_NODE_CONFIG_FILE', 'HGW_DATABASE_URL_FILE', 'HGW_MANAGED_DATA_APPROVAL_FILE',
])('rejects an escaped %s before returning configuration to a writer', async (name) => {
  const root = await ownedRoot()
  expect(() => testConfig(root, { [name]: join(root, '..', 'unowned-fixture-state') })).toThrow('escapes its owned temporary directory')
})

it('keeps subprocess and in-process paths identical, including explicit fixture overrides', async () => {
  const root = await ownedRoot()
  const env = testEnvironment(root, { HGW_STATE_ROOT: join(root, 'custom-state'), HGW_PORT: '9031' })
  expect(testConfig(root, env)).toMatchObject({ port: 9031, stateRoot: join(root, 'custom-state'),
    usersRoot: join(root, 'users'), projectRuntimesRoot: join(root, 'project-runtimes'),
    nodeConfigFile: join(root, 'custom-state', 'node-config.json') })
  expect(() => testEnvironment('relative-root')).toThrow('must be absolute')
})
