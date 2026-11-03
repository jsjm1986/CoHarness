/**
 * Public-access tunnel orchestration for one gateway node: resolves or installs
 * cloudflared, starts quick (`*.trycloudflare.com`, ephemeral) or named
 * (administrator's domain, fixed) tunnels, persists intent so a gateway restart
 * resumes the tunnel, and records observable state for the admin UI.
 *
 * Secret discipline: the Cloudflare API token and the tunnel run token live
 * only as `TunnelCredentialCipher` ciphertext in `harness.tunnel_access`; the
 * run token reaches cloudflared through its explicit TUNNEL_TOKEN environment
 * entry and never through argv, logs, audit rows, or API responses.
 */
import { z } from 'zod'
import {
  configureTunnel, createTunnel, deleteTunnel, deleteTunnelDns, getTunnelToken, resolveZone, upsertTunnelDns,
  CloudflareApiError,
} from './cloudflare-api.ts'
import type { PostgresTunnelAccessStore, TunnelCredentialCipher } from './postgres/tunnel-access-service.ts'
import {
  installCloudflared, resolveCloudflared, spawnNamedTunnel, spawnQuickTunnel,
  TunnelSupervisorError, type CloudflaredBinary, type TunnelLaunchOptions, type TunnelProc,
} from './tunnel-supervisor.ts'

/** A tunnel request was invalid, conflicted with current state, or its backend failed. */
export class TunnelAccessError extends Error {
  constructor(readonly status: 400 | 409 | 502 | 503, message: string) {
    super(message)
  }
}

const domainName = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu)
  .transform(value => value.toLowerCase())
const namedInput = z.object({
  /** Cloudflare API token; required the first time, optional while one stays stored. */
  apiToken: z.string().min(1).max(4096).optional(),
  /** Registrable domain of the Cloudflare zone, e.g. `example.com`; defaults to the hostname's last two labels. */
  domain: domainName.optional(),
  /** Full hostname to publish, e.g. `team.example.com`; must equal or end under the zone. */
  hostname: domainName,
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
  startupTimeoutMs: number
  closeTimeoutMs: number
  probeIntervalMs: number
  /** Explicit binary path override (HGW_CLOUDFLARED). */
  envBinaryPath?: string
  fetchImpl?: typeof fetch
  install?: (stateDir: string, signal?: AbortSignal) => Promise<CloudflaredBinary>
  resolveBinary?: (signal?: AbortSignal) => Promise<CloudflaredBinary | null>
  spawnQuick?: (bin: string, target: string, options: TunnelLaunchOptions) => TunnelProc | Promise<TunnelProc>
  spawnNamed?: (bin: string, runToken: string, options: TunnelLaunchOptions) => TunnelProc
}

export class GatewayTunnelAccess {
  private proc: TunnelProc | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private closing = false
  private shutdownAttempt: Promise<void> | undefined
  private readonly startupLifetime = new AbortController()
  private readonly acceptedStarts = new Set<AbortController>()
  private intentVersion = 0

  constructor(private readonly deps: TunnelAccessDeps) {}

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private fetch(signal = this.startupLifetime.signal): typeof fetch {
    const request = this.deps.fetchImpl ?? fetch
    return (url, init) => {
      signal.throwIfAborted()
      return request(url, { ...init, signal: AbortSignal.any(init?.signal ? [signal, init.signal] : [signal]) })
    }
  }

  private async cancellable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    try {
      const result = await work()
      signal.throwIfAborted()
      return result
    } catch (error) {
      signal.throwIfAborted()
      throw error
    }
  }

  private assertOpen(): void {
    if (this.closing) throw new TunnelAccessError(503, 'tunnel-shutting-down')
  }

  private start(work: (signal: AbortSignal) => Promise<TunnelAccessView>): Promise<TunnelAccessView> {
    this.assertOpen()
    this.intentVersion++
    const caller = new AbortController()
    this.acceptedStarts.add(caller)
    const signal = AbortSignal.any([caller.signal, this.startupLifetime.signal])
    return this.serialize(async () => {
      this.assertOpen(); signal.throwIfAborted()
      return this.cancellable(signal, () => work(signal))
    }).finally(() => { this.acceptedStarts.delete(caller) })
  }

  private cancelStarts(): void {
    this.intentVersion++
    for (const caller of this.acceptedStarts) caller.abort(new TunnelAccessError(409, 'tunnel-start-cancelled'))
  }

  private launchOptions(signal: AbortSignal): TunnelLaunchOptions {
    return { startupTimeoutMs: this.deps.startupTimeoutMs, closeTimeoutMs: this.deps.closeTimeoutMs,
      probeIntervalMs: this.deps.probeIntervalMs, signal }
  }

  private async launch(create: () => TunnelProc | Promise<TunnelProc>): Promise<TunnelProc> {
    try {
      const allocation = create()
      const proc = 'ready' in allocation ? allocation : await allocation
      this.proc = proc; this.watchProcess(proc)
      this.assertOpen()
      await proc.ready
      this.assertOpen()
      if (proc.hasExited()) throw new TunnelSupervisorError('start-failed', 'cloudflared closed before registration was published')
      return proc
    } catch (error) {
      await this.stopProcess(0)
      await this.deps.store.update({ state: 'error', public_url: null,
        last_error: error instanceof Error ? error.message : 'cloudflared failed to start' })
      if (error instanceof TunnelSupervisorError) throw new TunnelAccessError(502, error.message)
      throw error
    }
  }

  private async stopProcess(graceMs: number): Promise<void> {
    const proc = this.proc
    if (proc === null) return
    try { await proc.terminate(graceMs) } catch {
      await this.deps.store.update({ state: 'error', last_error: 'tunnel-stop-unconfirmed' })
      throw new TunnelAccessError(502, 'tunnel-stop-unconfirmed')
    }
    if (this.proc === proc) this.proc = null
  }

  /**
   * Read the current row and binary presence for the admin view.
   * @param signal - cancellation; defaults to this controller's shutdown signal.
   * @returns durable tunnel state and current installed-binary information.
   */
  async view(signal = this.startupLifetime.signal): Promise<TunnelAccessView> {
    const row = await this.deps.store.get()
    signal.throwIfAborted()
    const resolveBinary = this.deps.resolveBinary ?? (() =>
      resolveCloudflared({ envPath: this.deps.envBinaryPath, stateDir: this.deps.stateDir, signal }))
    const binary = await resolveBinary(signal)
    signal.throwIfAborted()
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
    this.assertOpen()
    return this.serialize(async () => {
      this.assertOpen()
      const signal = this.startupLifetime.signal
      const install = this.deps.install ?? ((state: string, cancellation?: AbortSignal) => installCloudflared(state, this.fetch(cancellation), cancellation))
      try {
        await this.cancellable(signal, () => install(this.deps.stateDir, signal))
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof TunnelSupervisorError) throw new TunnelAccessError(502, error.message)
        throw error
      }
      return this.view(signal)
    })
  }

  /** Stop the running tunnel; the named configuration stays for the next start. */
  async stop(): Promise<TunnelAccessView> {
    this.assertOpen()
    this.cancelStarts()
    return this.serialize(async () => {
      this.assertOpen()
      await this.deps.store.update({ desired: 'stopped' })
      await this.stopProcess(5_000)
      await this.deps.store.update({ state: 'stopped', public_url: null })
      return this.view()
    })
  }

  /** Remove the stored configuration, optionally deleting Cloudflare-side resources. */
  async clear(): Promise<TunnelAccessView> {
    this.assertOpen()
    this.cancelStarts()
    return this.serialize(() => this.cancellable(this.startupLifetime.signal, async () => {
      this.assertOpen()
      const row = await this.deps.store.get()
      await this.deps.store.update({ desired: 'stopped' })
      await this.stopProcess(5_000)
      if (row.apiTokenCipher !== null
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
    }))
  }

  private watchProcess(proc: TunnelProc): void {
    void proc.exited.then(({ code, signal }) => this.serialize(async () => {
      if (this.proc !== proc) return
      this.proc = null
      const row = await this.deps.store.get()
      if (row.desired !== 'running') {
        await this.deps.store.update({ state: 'stopped', public_url: null })
        return
      }
      await this.deps.store.update({
        state: 'error', public_url: null,
        last_error: `cloudflared exited (code ${String(code)}, signal ${String(signal)})`,
      })
    })).catch(error => this.serialize(async () => {
      if (this.proc === proc) await this.deps.store.update({ state: 'error', public_url: null, last_error: 'tunnel-stop-unconfirmed' })
      console.error('[gateway] tunnel exit-state update failed:', error)
    })).catch(error => { console.error('[gateway] tunnel cleanup-state update failed:', error) })
  }

  private async binaryOrMissing(signal: AbortSignal): Promise<CloudflaredBinary> {
    const resolveBinary = this.deps.resolveBinary ?? (() =>
      resolveCloudflared({ envPath: this.deps.envBinaryPath, stateDir: this.deps.stateDir, signal }))
    const binary = await resolveBinary(signal)
    signal.throwIfAborted()
    if (binary === null) {
      throw new TunnelAccessError(503, 'cloudflared-not-installed')
    }
    return binary
  }

  /** Start a quick tunnel; the random `*.trycloudflare.com` URL changes on every start. */
  async startQuick(): Promise<TunnelAccessView> {
    return this.start(async signal => {
      const binary = await this.binaryOrMissing(signal)
      await this.stopProcess(5_000)
      signal.throwIfAborted()
      await this.deps.store.update({
        mode: 'quick', desired: 'running', state: 'starting', public_url: null, last_error: null,
      })
      this.assertOpen()
      signal.throwIfAborted()
      const spawn = this.deps.spawnQuick ?? spawnQuickTunnel
      const proc = await this.launch(() => spawn(binary.path, this.deps.target, this.launchOptions(signal)))
      await this.deps.store.update({
        state: 'running', public_url: proc.publicUrl, started_at: new Date().toISOString(), last_error: null,
      })
      this.assertOpen()
      signal.throwIfAborted()
      return this.view(signal)
    })
  }

  /**
   * Start a named tunnel on the administrator's own domain. The first call
   * creates the Cloudflare-side tunnel, pushes the ingress, and points the DNS
   * record; later starts reuse the stored run token.
   */
  async startNamed(input: unknown): Promise<TunnelAccessView> {
    this.assertOpen()
    const parsed = namedInput.safeParse(input)
    if (!parsed.success) throw new TunnelAccessError(400, 'invalid-named-tunnel-input')
    return this.start(async signal => {
      const binary = await this.binaryOrMissing(signal)
      const row = await this.deps.store.get()
      signal.throwIfAborted()

      let { accountId, zoneId, tunnelId } = row
      const hostname = parsed.data.hostname
      let zoneDomain = row.domain
      let runToken: string | null = row.runTokenCipher === null ? null
        : this.deps.cipher.decrypt(this.deps.organizationId, this.deps.nodeId, 'run-token', row.runTokenCipher)
      const apiToken = parsed.data.apiToken ?? (row.apiTokenCipher === null ? null
        : this.deps.cipher.decrypt(this.deps.organizationId, this.deps.nodeId, 'api-token', row.apiTokenCipher))
      const hostnameChanged = hostname !== row.hostname
      const domain = parsed.data.domain ?? (!hostnameChanged ? row.domain : null) ?? hostname.split('.').slice(-2).join('.')
      if (apiToken === null && (hostnameChanged || tunnelId === null || runToken === null)) {
        throw new TunnelAccessError(400, 'cloudflare-api-token-required')
      }
      if (!hostname.endsWith(`.${domain}`) && hostname !== domain) {
        throw new TunnelAccessError(400, 'hostname-must-end-under-domain')
      }
      await this.stopProcess(5_000)
      signal.throwIfAborted()
      if (hostnameChanged) {
        // A new hostname needs the full Cloudflare-side setup pass again; drop
        // the previous tunnel and DNS record first so they do not orphan.
        if (row.tunnelId !== null && row.accountId !== null && apiToken !== null) {
          if (row.zoneId !== null && row.hostname !== null) {
            await deleteTunnelDns(this.fetch(signal), apiToken, row.zoneId, row.hostname, row.tunnelId)
              .catch(() => { /* stale DNS cleanup is best-effort; the tunnel delete is authoritative */ })
          }
          await deleteTunnel(this.fetch(signal), apiToken, row.accountId, row.tunnelId)
            .catch((error: unknown) => {
              if (!(error instanceof CloudflareApiError && error.code === 'not-found')) throw error
            })
        }
        tunnelId = null
        runToken = null
        zoneId = null
        zoneDomain = domain
        signal.throwIfAborted()
        await this.deps.store.update({
          mode: 'named', desired: 'running', state: 'starting', hostname, domain,
          tunnel_id: null, zone_id: null, run_token_cipher: null, public_url: null,
          api_token_cipher: apiToken === null ? row.apiTokenCipher
            : this.deps.cipher.encrypt(this.deps.organizationId, this.deps.nodeId, 'api-token', apiToken),
        })
      }
      if (apiToken !== null && (tunnelId === null || runToken === null || row.state === 'error' || row.state === 'starting')) {
        try {
          if (zoneId === null || accountId === null || parsed.data.domain !== undefined) {
            const zone = await resolveZone(this.fetch(signal), apiToken, domain)
            zoneId = zone.id
            zoneDomain = zone.name
            accountId = zone.accountId
          }
          if (accountId === null) throw new CloudflareApiError('api-failed', 'Cloudflare zone has no owning account')
          if (tunnelId === null) {
            const created = await createTunnel(this.fetch(signal), apiToken, accountId,
              `coharness-${this.deps.nodeId.slice(0, 8)}-${hostname}`)
            tunnelId = created.id
            await this.deps.store.update({
              mode: 'named', desired: 'running', state: 'starting', hostname, domain: zoneDomain,
              zone_id: zoneId, account_id: accountId, tunnel_id: tunnelId, run_token_cipher: null,
              api_token_cipher: this.deps.cipher.encrypt(this.deps.organizationId, this.deps.nodeId, 'api-token', apiToken),
              public_url: null,
            })
          }
          runToken ??= await getTunnelToken(this.fetch(signal), apiToken, accountId, tunnelId)
          await this.deps.store.update({ run_token_cipher: this.deps.cipher.encrypt(this.deps.organizationId, this.deps.nodeId, 'run-token', runToken) })
          await configureTunnel(this.fetch(signal), apiToken, accountId, tunnelId, hostname, this.deps.target)
          await upsertTunnelDns(this.fetch(signal), apiToken, zoneId, hostname, tunnelId)
        } catch (error) {
          await this.deps.store.update({ state: 'error', last_error: `cloudflare: ${error instanceof Error ? error.message : String(error)}` })
          if (error instanceof CloudflareApiError) throw new TunnelAccessError(502, `cloudflare-${error.code}: ${error.message}`)
          throw error
        }
      }
      if (runToken === null || tunnelId === null) {
        throw new TunnelAccessError(503, 'named-tunnel-not-provisioned')
      }
      signal.throwIfAborted()

      await this.deps.store.update({
        mode: 'named', desired: 'running', state: 'starting',
        hostname, domain: zoneDomain, zone_id: zoneId, account_id: accountId, tunnel_id: tunnelId,
        api_token_cipher: apiToken === null ? row.apiTokenCipher
          : this.deps.cipher.encrypt(this.deps.organizationId, this.deps.nodeId, 'api-token', apiToken),
        run_token_cipher: this.deps.cipher.encrypt(this.deps.organizationId, this.deps.nodeId, 'run-token', runToken),
        public_url: `https://${hostname}`, last_error: null,
      })
      this.assertOpen()
      signal.throwIfAborted()
      const spawn = this.deps.spawnNamed ?? spawnNamedTunnel
      const selectedRunToken = runToken
      await this.launch(() => spawn(binary.path, selectedRunToken, this.launchOptions(signal)))
      await this.deps.store.update({ state: 'running', started_at: new Date().toISOString(), last_error: null })
      this.assertOpen()
      signal.throwIfAborted()
      return this.view(signal)
    })
  }

  /** Re-launch the tunnel after a gateway restart when the administrator left it running. */
  async resume(): Promise<void> {
    if (this.closing) return
    const version = this.intentVersion
    const row = await this.deps.store.get()
    if (this.closing || version !== this.intentVersion) return
    if (row.desired !== 'running' || row.mode === 'off') return
    await (row.mode === 'quick' ? this.startQuick() : this.startNamed({ hostname: row.hostname ?? '' }))
      .catch((error: unknown) => { console.error('[gateway] tunnel resume failed:', error) })
  }

  /** Stop new actions, drain accepted work and confirm child closure without clearing resume intent; failed cleanup can be retried. */
  async shutdown(): Promise<void> {
    this.closing = true
    this.startupLifetime.abort(new TunnelAccessError(503, 'tunnel-shutting-down'))
    await (this.shutdownAttempt ??= this.serialize(async () => {
      await this.stopProcess(3_000)
      await this.deps.store.update({ state: 'stopped', public_url: null })
    }).catch(error => {
      this.shutdownAttempt = undefined
      throw error
    }))
  }
}
