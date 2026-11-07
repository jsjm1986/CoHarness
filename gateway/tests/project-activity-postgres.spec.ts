/** Real account HTTP pagination over PostgreSQL member activity and historical question answers. */
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GatewayRuntimeRouter, LocalRuntimeAdapter } from '../src/runtime-router.ts'
import { PostgresRuntimeCatalog } from '../src/postgres/runtime-catalog.ts'
import type { RuntimeNodeId } from '../src/runtime-catalog.ts'
import { InstanceManager } from '../src/instances.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { ConversationRepository } from '../src/postgres/conversation-repository.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { createGatewayServer } from '../src/server.ts'
import type { ProjectActivityPage } from '../src/services.ts'
import { testConfig } from './test-config.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('PostgreSQL project activity HTTP', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!)
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  it.for(['tie-order', 'sub-millisecond', 'unanchored-tie', 'delimited-session', 'invalid-cursor', 'invalid-answer', 'legacy-cursor', 'mixed-events'] as const)(
    'reads every activity once for %s', async (kind, { signal }) => {
      const root = await mkdtemp(join(tmpdir(), 'hgw-activity-pagination-'))
      let server: ReturnType<typeof createGatewayServer> | undefined
      let instances: InstanceManager | undefined
      try {
        const suffix = randomUUID(), slug = `activity-${suffix}`
        await pool.query(`WITH organization AS (
          INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Activity pagination') RETURNING id
        ) INSERT INTO harness.compute_nodes(organization_id,name) SELECT id,'activity-node' FROM organization`, [slug])
        const context = await resolvePostgresRuntimeContext(pool, slug, 'activity-node')
        const cfg = testConfig(root)
        const users = new PostgresUserService(context, cfg)
        const member = await users.create({ username: 'activity-member', password: 'pw-12345678' })
        await users.changeOwnPassword(member.id, 'pw-12345678')
        const projects = new PostgresProjectService(context, cfg)
        const project = await projects.createManaged({ name: 'Activity pagination', ownerUserId: member.id })
        const identities = (await pool.query<{ user_id: string; project_id: string }>(`SELECT u.id user_id,p.id project_id
          FROM harness.users u JOIN harness.projects p ON p.organization_id=u.organization_id
          WHERE u.organization_id=$1 AND u.public_id=$2 AND p.public_id=$3`,
        [context.organizationId, member.id, project.id])).rows[0]!
        const runtimeId = (await new PostgresInstanceRepository(context, cfg.instancePortBase).resolveTarget({ kind: 'project', id: project.id })).runtimeId!
        const sessions = new ConversationRepository(pool, { organizationId: context.organizationId, runtimeId })
        const collaboration = new PostgresCollaborationService(context)
        const firstId = `activity-${suffix}-a${kind === 'delimited-session' ? '|with-delimiter' : ''}`
        const secondId = kind === 'unanchored-tie' ? firstId : `activity-${suffix}-b`
        for (const id of new Set([firstId, secondId])) await sessions.create({
          id, organizationId: context.organizationId, runtimeId, creatorUserId: identities.user_id,
          projectId: identities.project_id, visibility: 'project', sessionFormatVersion: 0,
          createdAt: Date.parse('2026-10-20T00:00:00Z'), cwd: project.path,
        })
        const firstClaim = `activity-answer-${suffix}-a`, secondClaim = `activity-answer-${suffix}-b`
        const outcome = (text: string) => ({ answers: [
          ...(kind === 'invalid-answer' ? [null, 3, []] : []), { selected: [text] },
        ] })
        expect(await collaboration.claimInteraction(member.id, runtimeId, firstId, 'question', firstClaim, outcome('First'))).toBe(true)
        expect(await collaboration.claimInteraction(member.id, runtimeId, secondId, 'question', secondClaim, outcome('Second'))).toBe(true)
        await pool.query(`UPDATE harness.conversation_interaction_responses SET responded_at=
          CASE WHEN interaction_id=$2 THEN $4::timestamptz ELSE $5::timestamptz END
          WHERE organization_id=$1 AND interaction_id IN ($2,$3)`, [context.organizationId, firstClaim, secondClaim,
          kind === 'sub-millisecond' ? '2026-10-20T00:00:00.123456Z' : '2026-10-20T00:00:00.123000Z',
          kind === 'sub-millisecond' ? '2026-10-20T00:00:00.123455Z' : '2026-10-20T00:00:00.123000Z'])
        if (kind === 'mixed-events') await sessions.append(firstId, randomUUID(), [{
          type: 'user/message', seq: 0, time: Date.parse('2026-10-20T00:00:00.123Z'), surfaceOp: 'append',
          data: { role: 'user', content: [{ type: 'text', text: 'Message' }], source: { kind: 'user',
            participant: { userId: member.id, username: member.username, displayName: member.displayName,
              role: 'user', scope: { kind: 'project', projectId: project.id, projectName: project.name, mode: 'rw' } } } },
        }])
        instances = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg)
        server = createGatewayServer({ cfg, users, projects, collaboration, instances,
          runtimeRouter: new GatewayRuntimeRouter(new LocalRuntimeAdapter({ collaboration, instances }), { catalog: new PostgresRuntimeCatalog(context, cfg.runtimeCatalog), localNodeId: context.nodeId as RuntimeNodeId }),
          auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context) })
        await new Promise<void>((ready, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', ready) })
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        cfg.publicOrigins.push(base)
        const signedIn = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', signal,
          headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ username: member.username, password: 'pw-12345678' }) })
        const cookie = signedIn.headers.get('set-cookie')?.split(';')[0]
        await signedIn.arrayBuffer()
        expect(signedIn.status).toBe(302)
        if (cookie === undefined) throw new Error('Activity fixture did not receive its login cookie')
        const texts: string[] = [], cursors = new Set<string>(), statuses: number[] = []
        if (kind === 'invalid-cursor') {
          const encoded = (value: unknown) => 'v1.' + Buffer.from(JSON.stringify(value)).toString('base64url')
          const timestamp = '2026-10-20T00:00:00.123000Z'
          const invalid = [
            '8640000000000001|ignored|0', 'v1.%%%', 'v1.' + Buffer.from('{').toString('base64url'),
            encoded({ ts: timestamp }), encoded([timestamp, firstId, -1]),
            encoded(['2026-02-30T00:00:00.000000Z', firstId, -1, 'question:missing']),
            encoded(['0000-01-01T00:00:00.000000Z', firstId, -1, 'question:missing']),
            encoded([timestamp, firstId + '\0', -1, 'question:missing']),
            encoded([timestamp, firstId, -2, 'question:missing']),
            encoded([timestamp, firstId, Number.MAX_SAFE_INTEGER + 1, 'question:missing']),
            encoded([timestamp, firstId, -1, 'question:\0']), '0|ignored|0|extra',
          ]
          for (const before of invalid) {
            const url = new URL('/account/api/activity', base)
            url.searchParams.set('dshTarget', `project:${project.id}`)
            url.searchParams.set('limit', '1')
            url.searchParams.set('before', before)
            const response = await fetch(url, { headers: { cookie }, signal })
            const body = await response.text()
            expect(response.status, body).toBe(200)
            expect((JSON.parse(body) as ProjectActivityPage).items.map(item => item.text)).toEqual(['First'])
          }
        }
        let before: string | undefined = kind === 'invalid-cursor' ? '1e100|invalid|0'
          : kind === 'legacy-cursor' ? `${Date.parse('2026-10-20T00:00:00.123Z')}|${firstId}|-1` : undefined
        for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
          const url = new URL('/account/api/activity', base)
          url.searchParams.set('dshTarget', `project:${project.id}`)
          url.searchParams.set('limit', '1')
          if (before !== undefined) url.searchParams.set('before', before)
          const response = await fetch(url, { headers: { cookie }, signal })
          const body = await response.text()
          statuses.push(response.status)
          expect(response.status, body).toBe(200)
          const page = JSON.parse(body) as ProjectActivityPage
          texts.push(...page.items.map(item => item.text))
          before = page.nextBefore
          if (before === undefined) break
          expect(cursors.has(before)).toBe(false)
          cursors.add(before)
        }
        expect(texts).toEqual(kind === 'mixed-events' ? ['Message', 'First', 'Second'] : ['First', 'Second'])
        await expect(['# Project activity pagination', '', `scenario=${kind}`, `httpStatuses=${statuses.join(',')}`,
          `activities=${texts.join(',')}`, `terminalCursor=${before ?? '<none>'}`, '',
        ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, `snapshots/project-activity/${kind}.expected.md`))
      } finally {
        if (server !== undefined) {
          server.closeAllConnections()
          await new Promise<void>(closed => server!.close(() => { closed() }))
        }
        await instances?.stopAll()
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})
