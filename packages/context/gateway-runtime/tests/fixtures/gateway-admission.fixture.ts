/**
 * REAL-composition fixture for gateway admission tests. A test-only cordis.yml
 * boots the real credentials, Web server, Connection, frontend-static, and
 * GatewayRuntime plugins over a private loopback port, plus a probe plugin
 * whose `/api/probe` subtree reports the authenticated principal inside its
 * handler. Only the Gateway itself is absent — assertions are issued by the
 * same compact Ed25519 shape the proxy produces.
 */

import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import type { GatewayPrincipalClaims, GatewayRuntimeCredential } from '../../src/index.ts'
import GatewayRuntime from '../../src/index.ts'

/** One mux/host event source that stays open until the downlink closes. */
const idle = async function* (signal: AbortSignal): AsyncGenerator<never> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

export interface GatewayComposition {
  readonly ctx: Context
  readonly credential: GatewayRuntimeCredential
  /** Issue a compact signed assertion, overriding any claim. */
  readonly issue: (overrides?: Partial<GatewayPrincipalClaims>) => string
  readonly origin: string
  readonly port: number
  /** Dispose the composition, restore the credential env, and remove roots. */
  readonly dispose: () => Promise<void>
}

/**
 * Boot the deployed runtime composition under a private credential and port.
 * @returns the composed context, its assertion issuer, and its loopback origin.
 */
export async function loadGatewayComposition(): Promise<GatewayComposition> {
  const pair = generateKeyPairSync('ed25519')
  const credential: GatewayRuntimeCredential = {
    version: 1,
    gatewayUrl: 'http://127.0.0.1:8899',
    organization: 'acme',
    runtime: { kind: 'user', id: 9, generation: 7 },
    token: 'runtime-secret',
    principalPublicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  }
  const issue = (overrides: Partial<GatewayPrincipalClaims> = {}): string => {
    const now = Date.now()
    const claims: GatewayPrincipalClaims = {
      version: 1,
      issuer: 'harness-gateway',
      audience: 'dsh-runtime',
      organization: 'acme',
      user: { id: 9, username: 'lin', displayName: 'Lin', role: 'user' },
      scope: { kind: 'personal' },
      runtime: { kind: 'user', id: 9, generation: 7 },
      issuedAt: now,
      expiresAt: now + 30_000,
      nonce: 'nonce-1',
      ...overrides,
    }
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${payload}.${sign(null, Buffer.from(payload), pair.privateKey).toString('base64url')}`
  }

  const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-admission-'))
  const dist = join(root, 'dist')
  await mkdir(dist)
  await writeFile(join(dist, 'index.html'), '<head></head><body>shell</body>')
  await writeFile(join(root, 'credential.json'), JSON.stringify(credential))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: '${join(root, '.credentials.yaml')}'`,
    '    watch: false',
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-client-connection'",
    '- id: frontend',
    "  name: '@deepseek-ai/dsh-host-frontend-static'",
    '  config:',
    `    distIndex: '${join(dist, 'index.html')}'`,
    "- name: '@deepseek-ai/dsh-gateway-runtime'",
    "- name: 'probe'",
    '',
  ].join('\n'))

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  // The probe subtree and channel answer with the principal each handler
  // observes — evidence of admission plus AsyncLocalStorage propagation on
  // both carriers.
  const probe = {
    name: 'probe',
    inject: ['connection', 'gatewayRuntime'],
    apply(probeCtx: Context) {
      const subtree = probeCtx.connection.http.handlePrefix('/api/probe', (_req, res) => {
        const principal = probeCtx.gatewayRuntime.requireCurrent()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ user: principal.claims.user.id }))
      }, { authority: 'trusted-host' })
      const channel = probeCtx.connection.rpc.handle('/probe-rpc', async (_endpoint) => {
        const principal = probeCtx.gatewayRuntime.requireCurrent()
        return { ok: true as const, value: { user: principal.claims.user.id } }
      }, { authority: 'trusted-host' })
      return async () => {
        await subtree()
        await channel()
      }
    },
  }
  const apiProxy = {
    events: {
      mux: (_request: unknown, signal: AbortSignal) => idle(signal),
      host: (_request: unknown, signal: AbortSignal) => idle(signal),
    },
  } as unknown as ApiProxy
  ctx.provide('apiProxy', apiProxy)

  const previousFile = process.env.DSH_GATEWAY_CREDENTIAL_FILE
  const previousFd = process.env.DSH_GATEWAY_CREDENTIAL_FD
  const restoreEnv = (): void => {
    if (previousFile === undefined) delete process.env.DSH_GATEWAY_CREDENTIAL_FILE
    else process.env.DSH_GATEWAY_CREDENTIAL_FILE = previousFile
    if (previousFd === undefined) delete process.env.DSH_GATEWAY_CREDENTIAL_FD
    else process.env.DSH_GATEWAY_CREDENTIAL_FD = previousFd
  }
  delete process.env.DSH_GATEWAY_CREDENTIAL_FD
  process.env.DSH_GATEWAY_CREDENTIAL_FILE = join(root, 'credential.json')
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-credentials-local', LocalCredentials],
      ['@deepseek-ai/dsh-host-webserver', HttpServer],
      ['@deepseek-ai/dsh-client-connection', Connection],
      ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
      ['@deepseek-ai/dsh-gateway-runtime', GatewayRuntime],
      ['probe', probe],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
  } catch (error) {
    restoreEnv()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
  const port = ctx.webServer.port
  return {
    ctx,
    credential,
    issue,
    origin: `http://127.0.0.1:${String(port)}`,
    port,
    dispose: async () => {
      try {
        await ctx.fiber.dispose()
      } finally {
        restoreEnv()
        await rm(root, { recursive: true, force: true })
      }
    },
  }
}
