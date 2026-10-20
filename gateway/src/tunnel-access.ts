/**
 * Public-access tunnel orchestration for one gateway node: resolves or installs
 * cloudflared, starts quick (`*.trycloudflare.com`, ephemeral) or named
 * (administrator's domain, fixed) tunnels, persists intent so a gateway restart
 * resumes the tunnel, and records observable state for the admin UI.
 *
 * Secret discipline: the Cloudflare API token and the tunnel run token live
 * only as `TunnelCredentialCipher` ciphertext in `harness.tunnel_access`; the
 * run token reaches cloudflared through argv (a private machine account owns
 * the process list) and never through logs, audit rows, or API responses.
 */
import { z } from 'zod'
import {
  configureTunnel, createTunnel, deleteTunnel, deleteTunnelDns, resolveAccount, resolveZone, upsertTunnelDns,
  CloudflareApiError,
} from './cloudflare-api.ts'
import type { PostgresTunnelAccessStore, TunnelCredentialCipher } from './postgres/tunnel-access-service.ts'
import {
  installCloudflared, resolveCloudflared, spawnNamedTunnel, spawnQuickTunnel,
  TunnelSupervisorError, type CloudflaredBinary, type TunnelProc,
} from './tunnel-supervisor.ts'

/** A tunnel request was invalid, conflicted with current state, or its backend failed. */
export class TunnelAccessError extends Error {
  constructor(readonly status: 400 | 409 | 502 | 503, message: string) {
    super(message)
  }
}

const namedInput = z.object({
  /** Cloudflare API token; required the first time, optional while one stays stored. */
  apiToken: z.string().min(1).max(4096).optional(),
  /** Registrable domain of the Cloudflare zone, e.g. `example.com`; defaults to the hostname's last two labels. */
  domain: z.string().regex(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/iu).max(253).optional(),
  /** Full hostname to publish, e.g. `team.example.com`; must equal or end under the zone. */
  hostname: z.string().regex(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/iu).max(253),
}).strict()

/** Administrator-facing tunnel view; carries no secret material. */
export interface TunnelAccessView {
  supported: boolean
  binary: { path: string; version: string | null; source: string } | null
  mode: 'off' | 'quick' | 'named'
  desired: 'stopped' | 'running'
  state: 'stopped' | 'starting' | 'running' | 'error'
  publicUrl: string | null
  hostname: string | null
  domain: string | null
  apiTokenConfigured: boolean
  lastError: string | null
  revision: number
  startedAt: string | null
  updatedAt: string
}

/** Dependencies the orchestrator consumes; the process side is injectable for tests. */
export interface TunnelAccessDeps {
  store: Pick<PostgresTunnelAccessStore, 'get' | 'update'>
  cipher: Pick<TunnelCredentialCipher, 'encrypt' | 'decrypt'>
  organizationId: string
  nodeId: string
  /** Loopback service the tunnel forwards to — the gateway's own listener. */
  target: string
  /** Private state directory for the managed cloudflared binary. */
  stateDir: string
  /** Explicit binary path override (HGW_CLOUDFLARED). */
  envBinaryPath?: string
  fetchImpl?: typeof fetch
  install?: (stateDir: string) => Promise<CloudflaredBinary>
  resolveBinary?: () => Promise<CloudflaredBinary | null>
  spawnQuick?: (bin: string, target: string) => Promise<TunnelProc>
  spawnNamed?: (bin: string, runToken: string) => TunnelProc
}

export class GatewayTunnelAccess {
  private proc: TunnelProc | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: TunnelAccessDeps) {}

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private fetch(): typeof fetch {
    return this.deps.fetchImpl ?? fetch
  }

  /** Read the current row and binary presence for the admin view. */
  async view(): Promise<TunnelAccessView> {
    const row = await this.deps.store.get()
    const resolveBinary = this.deps.resolveBinary ?? (() =>
      resolveCloudflared({ envPath: this.deps.envBinaryPath, stateDir: this.deps.stateDir }))
    const binary = await resolveBinary()
    return {
      supported: process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32',
      binary: binary === null ? null : { path: binary.path, version: binary.version, source: binary.source },
      mode: row.mode,
      desired: row.desired,
      state: row.state,
      publicUrl: row.publicUrl,
      hostname: row.hostname,
      domain: row.domain,
      apiTokenConfigured: row.apiTokenCipher !== null,
      lastError: row.lastError,
      revision: row.revision,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
    }
  }

  /** Download the pinned cloudflared release into the state directory. */
  async install(): Promise<TunnelAccessView> {
    return this.serialize(async () => {
      const install = this.deps.install ?? installCloudflared
      try {
        await install(this.deps.stateDir)
      } catch (error) {
        if (error instanceof TunnelSupervisorError) throw new TunnelAccessError(502, error.message)
        throw error
      }
      return this.view()
    })
  }

  /** Stop the running tunnel; the named configuration stays for the next start. */
  async stop(): Promise<TunnelAccessView> {
    return this.serialize(async () => {
      await this.deps.store.update({ desired: 'stopped' })
      const proc = this.proc
      this.proc = null
      if (proc !== null) await proc.terminate(5_000).catch(() => { /* stop intent is already recorded; a stuck child still dies with the gateway */ })
      await this.deps.store.update({ state: 'stopped', public_url: null })
      return this.view()
    })
  }

  /** Remove the stored configuration, optionally deleting Cloudflare-side resources. */
  async clear(): Promise<TunnelAccessView> {
    return this.serialize(async () => {
      const row = await this.deps.store.get()
      const proc = this.proc
      this.proc = null
      if (proc !== null) await proc.terminate(5_000).catch(() => { /* clear proceeds even when the child ignores SIGTERM */ })
      if (row.mode === 'named' && row.apiTokenCipher !== null
        && row.accountId !== null && row.tunnelId !== null) {
        const apiToken = this.deps.cipher.decrypt(this.deps.organizationId, this.deps.nodeId, 'api-token', row.apiTokenCipher)
        if (row.zoneId !== null && row.hostname !== null) {
          await deleteTunnelDns(this.fetch(), apiToken, row.zoneId, row.hostname, row.tunnelId)
            .catch(() => { /* DNS cleanup is best-effort; the tunnel delete is authoritative */ })
        }
        await deleteTunnel(this.fetch(), apiToken, row.accountId, row.tunnelId)
          .catch((error: unknown) => {
            if (!(error instanceof CloudflareApiError && error.code === 'not-found')) throw error
          })
      }
      await this.deps.store.update({
        mode: 'off', desired: 'stopped', state: 'stopped', public_url: null, hostname: null,
        domain: null, zone_id: null, account_id: null, tunnel_id: null, api_token_cipher: null,
        run_token_cipher: null, last_error: null, started_at: null,
      })
      return this.view()
    })
  }

  private watchProcess(proc: TunnelProc): void {
    void proc.exited.then(({ code, signal }) => {
      if (this.proc !== proc) return
      this.proc = null
      void this.deps.store.get().then(async row => {
        if (row.desired !== 'running') {
          await this.deps.store.update({ state: 'stopped', public_url: null })
            .catch(() => { /* a lost exit-state write only hides a stale row until the next view */ })
          return
        }
        // An unexpected exit keeps the desired flag so a gateway restart retries,
        // while the admin sees the failure rather than a phantom "running" state.
        await this.deps.store.update({
          state: 'error',
          public_url: null,
          last_error: `cloudflared exited (code ${String(code)}, signal ${String(signal)})`,
        }).catch(() => { /* same best-effort rationale as the stopped write above */ })
      }).catch(() => { /* a lost store read leaves the row at its last recorded state */ })
    })
  }

  private async binaryOrMissing(): Promise<CloudflaredBinary> {
    const resolveBinary = this.deps.resolveBinary ?? (() =>
      resolveCloudflared({ envPath: this.deps.envBinaryPath, stateDir: this.deps.stateDir }))
    const binary = await resolveBinary()
    if (binary === null) {
      throw new TunnelAccessError(503, 'cloudflared-not-installed')
    }
    return binary
  }

  /** Start a quick tunnel; the random `*.trycloudflare.com` URL changes on every start. */
  async startQuick(): Promise<TunnelAccessView> {
    return this.serialize(async () => {
      const binary = await this.binaryOrMissing()
      const existing = this.proc
      this.proc = null
      if (existing !== null) await existing.terminate(5_000).catch(() => { /* a replaced child may already be gone */ })
      await this.deps.store.update({
        mode: 'quick', desired: 'running', state: 'starting', public_url: null, last_error: null,
      })
      const spawn = this.deps.spawnQuick ?? spawnQuickTunnel
      const proc = await spawn(binary.path, this.deps.target).catch(async (error: unknown) => {
        await this.deps.store.update({
          state: 'error',
          last_error: error instanceof Error ? error.message : 'cloudflared failed to start',
        })
        if (error instanceof TunnelSupervisorError) throw new TunnelAccessError(502, error.message)
        throw error
      })
      this.proc = proc
      this.watchProcess(proc)
      await this.deps.store.update({
        state: 'running', public_url: proc.publicUrl, started_at: new Date().toISOString(), last_error: null,
      })
      return this.view()
    })
  }

  /**
   * Start a named tunnel on the administrator's own domain. The first call
   * creates the Cloudflare-side tunnel, pushes the ingress, and points the DNS
   * record; later starts reuse the stored run token.
   */
  async startNamed(input: unknown): Promise<TunnelAccessView> {
    return this.serialize(async () => {
      const parsed = namedInput.safeParse(input)
      if (!parsed.success) throw new TunnelAccessError(400, 'invalid-named-tunnel-input')
      const binary = await this.binaryOrMissing()
      const row = await this.deps.store.get()

      let { accountId, zoneId, tunnelId } = row
      const hostname = parsed.data.hostname
      let zoneDomain = row.domain
      let runToken: string | null = row.runTokenCipher === null ? null
        : this.deps.cipher.decrypt(this.deps.organizationId, this.deps.nodeId, 'run-token', row.runTokenCipher)
      const apiToken = parsed.data.apiToken ?? (row.apiTokenCipher === null ? null
        : this.deps.cipher.decrypt(this.deps.organizationId, this.deps.nodeId, 'api-token', row.apiTokenCipher))

      if (parsed.data.hostname !== row.hostname) {
        // A new hostname needs the full Cloudflare-side setup pass again; drop
        // the previous tunnel and DNS record first so they do not orphan.
        if (row.mode === 'named' && row.tunnelId !== null && row.accountId !== null && apiToken !== null) {
          if (row.zoneId !== null && row.hostname !== null) {
            await deleteTunnelDns(this.fetch(), apiToken, row.zoneId, row.hostname, row.tunnelId)
              .catch(() => { /* stale DNS cleanup is best-effort; the tunnel delete is authoritative */ })
          }
          await deleteTunnel(this.fetch(), apiToken, row.accountId, row.tunnelId)
            .catch((error: unknown) => {
              if (!(error instanceof CloudflareApiError && error.code === 'not-found')) throw error
            })
        }
        tunnelId = null
        runToken = null
      }
      const domain = parsed.data.domain ?? hostname.split('.').slice(-2).join('.')
      if (apiToken === null && (tunnelId === null || runToken === null)) {
        throw new TunnelAccessError(400, 'cloudflare-api-token-required')
      }
      if (!hostname.endsWith(`.${domain}`) && hostname !== domain) {
        throw new TunnelAccessError(400, 'hostname-must-end-under-domain')
      }

      if (apiToken !== null && (tunnelId === null || runToken === null)) {
        try {
          if (accountId === null) accountId = (await resolveAccount(this.fetch(), apiToken)).id
          if (zoneId === null || parsed.data.domain !== undefined) {
            const zone = await resolveZone(this.fetch(), apiToken, domain)
            zoneId = zone.id
            zoneDomain = zone.name
          }
          if (tunnelId === null) {
            const created = await createTunnel(this.fetch(), apiToken, accountId,
              `coharness-${this.deps.nodeId.slice(0, 8)}-${hostname}`)
            tunnelId = created.id
            runToken = created.token
          }
          await configureTunnel(this.fetch(), apiToken, accountId, tunnelId, hostname, this.deps.target)
          await upsertTunnelDns(this.fetch(), apiToken, zoneId, hostname, tunnelId)
        } catch (error) {
          await this.deps.store.update({ state: 'error', last_error: `cloudflare: ${error instanceof Error ? error.message : String(error)}` })
          if (error instanceof CloudflareApiError) throw new TunnelAccessError(502, `cloudflare-${error.code}: ${error.message}`)
          throw error
        }
      }
      if (runToken === null || tunnelId === null) {
        throw new TunnelAccessError(503, 'named-tunnel-not-provisioned')
      }

      const existing = this.proc
      this.proc = null
      if (existing !== null) await existing.terminate(5_000).catch(() => { /* a replaced child may already be gone */ })
      await this.deps.store.update({
        mode: 'named', desired: 'running', state: 'starting',
        hostname, domain: zoneDomain, zone_id: zoneId, account_id: accountId, tunnel_id: tunnelId,
        api_token_cipher: apiToken === null ? row.apiTokenCipher
          : this.deps.cipher.encrypt(this.deps.organizationId, this.deps.nodeId, 'api-token', apiToken),
        run_token_cipher: this.deps.cipher.encrypt(this.deps.organizationId, this.deps.nodeId, 'run-token', runToken),
        public_url: `https://${hostname}`, last_error: null,
      })
      const spawn = this.deps.spawnNamed ?? spawnNamedTunnel
      const proc = spawn(binary.path, runToken)
      this.proc = proc
      this.watchProcess(proc)
      // cloudflared logs one "Registered tunnel connection" line per edge
      // connection; treat the process staying alive briefly as ready.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000)
        void proc.exited.then(() => { clearTimeout(timer); resolve() })
      })
      if (proc.hasExited()) {
        await this.deps.store.update({ state: 'error', last_error: 'cloudflared exited before the tunnel registered' })
        throw new TunnelAccessError(502, 'named-tunnel-start-failed')
      }
      await this.deps.store.update({ state: 'running', started_at: new Date().toISOString(), last_error: null })
      return this.view()
    })
  }

  /** Re-launch the tunnel after a gateway restart when the administrator left it running. */
  async resume(): Promise<void> {
    const row = await this.deps.store.get()
    if (row.desired !== 'running' || row.mode === 'off') return
    await (row.mode === 'quick' ? this.startQuick() : this.startNamed({ hostname: row.hostname ?? '' }))
      .catch((error: unknown) => { console.error('[gateway] tunnel resume failed:', error) })
  }

  /** Stop the supervised child without clearing intent (gateway shutdown path). */
  async shutdown(): Promise<void> {
    const proc = this.proc
    this.proc = null
    if (proc !== null) await proc.terminate(3_000).catch(() => {})
  }
}
