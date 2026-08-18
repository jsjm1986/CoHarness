import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createAdminApiHandler } from '../src/admin-api.ts'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import { ProjectService } from '../src/projects.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { UserService } from '../src/users.ts'

const EXPECTED = join(
  process.cwd(),
  'gateway/tests/snapshots/admin-project-directory/flow.expected.md',
)
const refreshing = process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh'

it('runs the administrator host-directory import through the real Gateway HTTP server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hgw-admin-directory-snapshot-'))
  const imports = join(root, 'imports')
  const existing = join(imports, 'existing-app')
  const hidden = join(imports, '.hidden-reference')
  mkdirSync(existing, { recursive: true })
  mkdirSync(hidden)
  const db = openDb(join(root, 'gateway.sqlite'))
  const cfg = loadConfig({
    HGW_USERS_ROOT: join(root, 'users'),
    HGW_STATE_ROOT: join(root, 'state'),
    HGW_PROJECT_RUNTIMES_ROOT: join(root, 'project-runtimes'),
    HGW_PROJECTS_ROOT: join(root, 'projects', 'admin'),
    HGW_USER_PROJECTS_ROOT: join(root, 'projects', 'user-projects'),
    HGW_GATEWAY_DIR: join(root, 'gateway'),
    HGW_DSH_REPO_ROOT: join(root, 'release'),
    HGW_GUARD_PATCH: 'off',
    HGW_MODEL_GOVERNANCE_PACKAGE: join(root, 'model-governance'),
  })
  const deps: GatewayDeps = {
    cfg,
    auth: new AuthService(db, cfg),
    users: new UserService(db, cfg),
    projects: new ProjectService(db, cfg),
    audit: new AuditService(db),
    instances: new InstanceManager(db, cfg),
  }
  const admin = await deps.users.create({ username: 'admin', password: 'pw-12345678', role: 'admin' })
  await deps.users.changeOwnPassword(admin.id, 'pw-12345678')
  const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })

  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    cfg.publicOrigins.push(base)
    const cookie = await login(base)
    const browseBefore = await fetch(
      `${base}/admin/api/project-directories?path=${encodeURIComponent(imports)}`,
      { headers: { cookie } },
    )
    const before = await browseBefore.json() as DirectoryListing
    const create = await fetch(`${base}/admin/api/projects`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Existing App', path: existing }),
    })
    const project = await create.json() as ProjectResult
    const browseAfter = await fetch(
      `${base}/admin/api/project-directories?path=${encodeURIComponent(imports)}`,
      { headers: { cookie } },
    )
    const after = await browseAfter.json() as DirectoryListing

    const transcript = normalize(root, [
      '# Administrator host directory import',
      '',
      '## Browse before import',
      `status=${String(browseBefore.status)}`,
      `scope=${before.scope}`,
      `path=${before.path ?? '<virtual>'}`,
      `selectable=${String(before.selectable)}`,
      ...entryLines(before),
      '',
      '## Create project',
      `status=${String(create.status)}`,
      `name=${project.name}`,
      `path=${project.path}`,
      `origin=${project.origin ?? '<legacy>'}`,
      '',
      '## Browse after import',
      `status=${String(browseAfter.status)}`,
      ...entryLines(after),
      '',
    ].join('\n'))
    if (refreshing) {
      mkdirSync(join(process.cwd(), 'gateway/tests/snapshots/admin-project-directory'), { recursive: true })
      await import('node:fs/promises').then(({ writeFile }) => writeFile(EXPECTED, transcript))
    }
    await expect(transcript).toMatchFileSnapshot(EXPECTED)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

interface DirectoryListing {
  scope: string
  path: string | null
  selectable: boolean
  entries: Array<{ name: string; path: string; hidden: boolean }>
}

interface ProjectResult {
  name: string
  path: string
  origin?: string
}

async function login(base: string): Promise<string> {
  const response = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ username: 'admin', password: 'pw-12345678' }),
  })
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

function entryLines(listing: DirectoryListing): string[] {
  return listing.entries
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map(entry => `entry=${entry.name} hidden=${String(entry.hidden)} path=${entry.path}`)
}

function normalize(root: string, value: string): string {
  return value.replaceAll(realpathSync(root), '$ROOT').replaceAll(root, '$ROOT')
}
