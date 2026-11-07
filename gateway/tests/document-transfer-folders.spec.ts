/** Gateway source transfers through built document HTTP/filesystem services in private roots. */
import { generateKeyPairSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalUserDocStore from '@deepseek-ai/dsh-userdoc-local'
import { handleUserDocHttp, userDocHttpHost } from '@deepseek-ai/dsh-host-userdoc-http'
import { describe, expect, it } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import {
  DocumentTransferError,
  createDocumentTransferCommitHandler,
  createDocumentTransferPlanHandler,
  type DocumentTransferDependencies,
  type DocumentTransferScope,
  type RuntimeDocumentTransferHandler,
  type RuntimeDocumentTransferPlanHandler,
} from '../src/document-transfer.ts'
import { GatewayPrincipalSigner, type GatewayPrincipalClaims } from '../src/principal.ts'
import type { RuntimeCredentialSubject } from '../src/runtime-api.ts'

const PROJECT_ID = 41
const SOURCE_DOC = 'source-folder/selected.txt'
const DESTINATION = 'destination-folder'
const SOURCE_BYTES = Buffer.from('isolated folder transfer\n')
const PRESERVED_BYTES = Buffer.from('existing target document\n')

interface FolderFixture {
  readonly source: DocumentTransferScope
  readonly target: DocumentTransferScope
  readonly sourceRoot: string
  readonly targetRoot: string
  readonly sourceOrigin: string
  readonly subject: RuntimeCredentialSubject
  readonly principal: GatewayPrincipalClaims
  readonly plan: RuntimeDocumentTransferPlanHandler
  readonly commit: RuntimeDocumentTransferHandler
  readonly requests: readonly { readonly scope: string; readonly method: string; readonly pathname: string }[]
}

async function withFixture(
  sourceKind: 'personal' | 'project',
  operation: (fixture: FolderFixture) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-transfer-folders-'))
  const servers: Server[] = []
  const contexts: Context[] = []
  const requests = new Set<Promise<void>>()
  const failures: unknown[] = []
  try {
    const homePath = join(root, 'home')
    const projectPath = join(root, 'project')
    const personalRoot = join(homePath, 'documents')
    const projectRoot = join(projectPath, 'documents')
    const sourceRoot = sourceKind === 'personal' ? personalRoot : projectRoot
    const targetRoot = sourceKind === 'personal' ? projectRoot : personalRoot
    for (const documents of [personalRoot, projectRoot]) {
      await mkdir(join(documents, 'source-folder'), { recursive: true })
      await mkdir(join(documents, DESTINATION), { recursive: true })
    }
    await writeFile(join(sourceRoot, SOURCE_DOC), SOURCE_BYTES)
    await writeFile(join(targetRoot, DESTINATION, 'existing.txt'), PRESERVED_BYTES)
    const user: UserRow = {
      id: 7, username: 'fixture', displayName: 'Fixture', role: 'user', status: 'active',
      homePath, mustChangePassword: false, autoReviewEligible: false,
    }
    const project = {
      id: PROJECT_ID, name: 'Fixture project', path: projectPath,
      memberCount: 1, origin: 'admin' as const, members: [],
    }
    const users = { getById: async (id: number) => id === user.id ? user : null }
    const projects = { getById: async (id: number) => id === PROJECT_ID ? project : null }
    const collaboration = {
      projectForUser: async (id: number, actorId: number) => id === PROJECT_ID && actorId === user.id
        ? { projectId: PROJECT_ID, name: project.name, path: projectPath, mode: 'rw' as const, administrator: false, canManage: false, uiThemePolicy: 'follow-user' as const }
        : null,
    }
    const { privateKey } = generateKeyPairSync('ed25519')
    const principals = new GatewayPrincipalSigner(privateKey, 'fixture-organization', 60_000)
    const wire: Array<{ scope: string; method: string; pathname: string }> = []
    const start = async (scope: DocumentTransferScope, documentsRoot: string): Promise<number> => {
      const context = new Context()
      contexts.push(context)
      await context.plugin(LocalUserDocStore, { uploadRoot: documentsRoot, uploadMinFreeBytes: 0 })
      const host = userDocHttpHost(context)
      const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const pathname = new URL(req.url ?? '/', 'http://fixture').pathname
        wire.push({ scope: scope.kind, method: req.method ?? 'GET', pathname })
        await handleUserDocHttp(host, req, res)
      }
      const server = createServer((req, res) => {
        const owned: Promise<void> = serve(req, res).catch((error: unknown) => {
          if (res.destroyed || res.writableEnded) return
          if (res.headersSent) { res.destroy(error instanceof Error ? error : new Error(String(error))); return }
          res.writeHead(error instanceof DocumentTransferError ? error.status : 500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: {
            code: error instanceof DocumentTransferError ? error.code : 'FIXTURE_FAILED',
            message: error instanceof Error ? error.message : String(error),
          } }))
        }).finally(() => { requests.delete(owned) })
        requests.add(owned)
      })
      servers.push(server)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
      })
      return (server.address() as AddressInfo).port
    }
    const personalPort = await start({ kind: 'personal' }, personalRoot)
    const projectPort = await start({ kind: 'project', projectId: PROJECT_ID }, projectRoot)
    const dependencies: DocumentTransferDependencies = {
      users, projects, collaboration, principals,
      instances: {
        ensureRunning: async owner => ({ port: 'username' in owner ? personalPort : projectPort, generation: 1 }),
      },
    }
    const principal: GatewayPrincipalClaims = {
      version: 1, issuer: 'harness-gateway', audience: 'dsh-runtime', organization: 'fixture-organization',
      user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role },
      scope: { kind: 'personal' }, runtime: { kind: 'user', id: user.id, generation: 1 },
      issuedAt: 1, expiresAt: Number.MAX_SAFE_INTEGER, nonce: 'fixture',
    }
    await operation({
      source: sourceKind === 'personal' ? { kind: 'personal' } : { kind: 'project', projectId: PROJECT_ID },
      target: sourceKind === 'personal' ? { kind: 'project', projectId: PROJECT_ID } : { kind: 'personal' },
      sourceRoot, targetRoot, principal,
      sourceOrigin: `http://127.0.0.1:${String(sourceKind === 'personal' ? personalPort : projectPort)}`,
      subject: { organizationId: 'fixture-organization', target: { kind: 'user', id: user.id }, generation: 1, userInternalId: 'fixture' },
      plan: createDocumentTransferPlanHandler(dependencies),
      commit: createDocumentTransferCommitHandler(dependencies),
      requests: wire,
    })
  } catch (error) {
    failures.push(error)
  } finally {
    for (const server of servers.reverse()) {
      try {
        if (!server.listening) continue
        const closed = new Promise<void>((resolve, reject) => { server.close(error => error === undefined ? resolve() : reject(error)) })
        server.closeAllConnections()
        await closed
      } catch (error) { failures.push(error) }
    }
    const settled = await Promise.allSettled([...requests])
    for (const result of settled) if (result.status === 'rejected') failures.push(result.reason)
    for (const context of contexts.reverse()) {
      try { await context.fiber.dispose() } catch (error) { failures.push(error) }
    }
    try {
      await rm(root, { recursive: true, force: true })
      expect(existsSync(root)).toBe(false)
    } catch (error) { failures.push(error) }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'document transfer folder fixture failed')
}

describe('Gateway transfer plans over real document folders', () => {
  it.each(['personal', 'project'] as const)('plans and commits a nested %s document into a different destination folder', async (sourceKind) => {
    await withFixture(sourceKind, async (fixture) => {
      const root = await fetch(`${fixture.sourceOrigin}/api/documents?limit=100`)
      expect(root.status).toBe(200)
      expect(await root.json()).toMatchObject({ documents: [] })
      expect(await readFile(join(fixture.sourceRoot, SOURCE_DOC))).toEqual(SOURCE_BYTES)
      const payload = {
        version: 1 as const, source: fixture.source, target: fixture.target,
        directory: DESTINATION, documents: [{ docId: SOURCE_DOC }],
      }
      const signal = new AbortController().signal
      const plan = await fixture.plan({ subject: fixture.subject, principal: fixture.principal, payload, signal })
      expect(plan.documents).toMatchObject([{ docId: SOURCE_DOC, name: 'selected.txt', bytes: SOURCE_BYTES.length }])
      expect(fixture.requests.every(request => request.method === 'GET' && request.pathname === '/api/documents')).toBe(true)
      expect(existsSync(join(fixture.targetRoot, DESTINATION, 'selected.txt'))).toBe(false)
      const copied = await fixture.commit({
        request: {} as IncomingMessage, subject: fixture.subject, principal: fixture.principal,
        payload: { ...payload, planId: plan.planId }, signal,
      })
      expect(copied.items).toMatchObject([{
        status: 'copied', target: { docId: `${DESTINATION}/selected.txt`, bytes: SOURCE_BYTES.length },
      }])
      expect(await readFile(join(fixture.targetRoot, DESTINATION, 'selected.txt'))).toEqual(SOURCE_BYTES)
      expect(await readFile(join(fixture.sourceRoot, SOURCE_DOC))).toEqual(SOURCE_BYTES)
      expect(await readFile(join(fixture.targetRoot, DESTINATION, 'existing.txt'))).toEqual(PRESERVED_BYTES)
    })
  })

  it.each(['missing', 'wrong-scope'] as const)('refuses a %s source without opening bytes or changing the destination', async (scenario) => {
    await withFixture('personal', async (fixture) => {
      await expect(fixture.plan({
        subject: fixture.subject, principal: fixture.principal, signal: new AbortController().signal,
        payload: {
          version: 1, directory: DESTINATION,
          source: scenario === 'wrong-scope' ? fixture.target : fixture.source,
          target: scenario === 'wrong-scope' ? fixture.source : fixture.target,
          documents: [{ docId: scenario === 'missing' ? 'source-folder/missing.txt' : SOURCE_DOC }],
        },
      })).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND', status: 404 })
      expect(fixture.requests.every(request => request.method === 'GET' && request.pathname === '/api/documents')).toBe(true)
      expect(existsSync(join(fixture.targetRoot, DESTINATION, 'selected.txt'))).toBe(false)
      expect(await readFile(join(fixture.sourceRoot, SOURCE_DOC))).toEqual(SOURCE_BYTES)
      expect(await readFile(join(fixture.targetRoot, DESTINATION, 'existing.txt'))).toEqual(PRESERVED_BYTES)
    })
  })
})
