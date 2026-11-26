/** Exact connection permissions for recovered runtimes; ordinary runtimes keep their existing policy. */
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { recoveryCanonical, recoveryHash } from './recovery-digest.ts'
import type { RecoveryReviewItem } from './recovery-policy.ts'

/** Approved connector configuration; no credentials or configuration contents are retained. */
export interface RecoveryConnection {
  readonly kind: 'mcp' | 'hook'
  readonly id: string
  readonly configurationSha256: string
}
/** MCP transport fields whose change requires another execution review. */
export interface RecoveryMcpInput {
  readonly transport: 'stdio' | 'streamable-http'
  readonly serverName: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly expandTemplates?: boolean
}
/** One parsed hook immediately before its command executes. */
export interface RecoveryHookInput {
  readonly dialect: 'codex' | 'claude-code'
  readonly configPath: string
  readonly point: string
  readonly command: string
  readonly configSha256: string
}
/** Identify an MCP target before credential expansion.
 * @param input Exact transport configuration with credential references intact.
 * @returns Digest that the inspector and each connect/probe attempt share.
 */
export function recoveryMcpConnection(input: RecoveryMcpInput): RecoveryConnection {
  const fields = input.transport === 'stdio'
    ? { command: input.command ?? '', args: input.args ?? [], env: input.env ?? {}, cwd: input.cwd ?? '' }
    : { url: input.url ?? '', headers: input.headers ?? {} }
  return { kind: 'mcp', id: input.serverName, configurationSha256: recoveryHash(recoveryCanonical({ transport: input.transport,
    expandTemplates: input.expandTemplates ?? false, ...fields })) }
}
/** Identify a hook using its complete source-file digest and selected command.
 * @param input Parsed hook and its immutable configuration bytes.
 * @returns Digest checked again before every execution.
 */
export function recoveryHookConnection(input: RecoveryHookInput): RecoveryConnection {
  const fields = { ...input, configPath: resolve(input.configPath) }
  return { kind: 'hook', id: `${input.dialect}:${fields.configPath}:${input.point}`, configurationSha256: recoveryHash(recoveryCanonical(fields)) }
}
/** Test a connector against the sealed launch permission.
 * @param ctx Calling plugin context.
 * @param connection Exact currently requested connection.
 * @returns True for ordinary runtimes or an explicitly approved recovered connection.
 */
export function recoveryConnectionPermitted(ctx: Context, connection: RecoveryConnection): boolean {
  const policy = ctx.get('recoveryPolicy')
  return policy === undefined || policy.composition.connections?.some(item => item.kind === connection.kind && item.id === connection.id
    && item.configurationSha256 === connection.configurationSha256) === true
}
/** Refuse an MCP connect or probe before credentials are expanded or a process is created.
 * @param ctx Calling plugin context.
 * @param input Original transport configuration.
 */
export function assertRecoveryMcpConnection(ctx: Context, input: RecoveryMcpInput): void {
  if (!recoveryConnectionPermitted(ctx, recoveryMcpConnection(input))) throw new Error('This MCP connection is paused until its disaster-recovery execution review is approved.')
}
/** Check both the loaded hook configuration and its current file before launching a command.
 * @param ctx Calling hook bridge context.
 * @param input Hook parsed from the original configuration.
 * @returns Whether this exact hook and unchanged configuration file have execution permission.
 */
export function recoveryHookPermitted(ctx: Context, input: RecoveryHookInput): boolean {
  if (ctx.get('recoveryPolicy') === undefined) return true
  let current: string
  try { current = recoveryHash(readFileSync(input.configPath)) } catch { return false }
  return current === input.configSha256 && recoveryConnectionPermitted(ctx, recoveryHookConnection(input))
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

/** Enumerate literal connector targets without loading restored plugin modules.
 * @param row Effective plugin row and its inspected code permission.
 * @param owner Artifact and entry identity owning these targets.
 * @param cwd Exact launch directory used for relative hook files.
 * @param approvedItems Individually reviewed item digests.
 * @returns Reviewed connection permissions and separately reviewable targets.
 */
export function inspectRecoveryConnections(
  row: EntryOptions, owner: RecoveryReviewItem, cwd: string | undefined, approvedItems: ReadonlySet<string>,
): {
  connections: RecoveryConnection[]
  items: RecoveryReviewItem[]
} {
  const connections: RecoveryConnection[] = [], items: RecoveryReviewItem[] = []
  if (!record(row.config) || owner.artifactSha256 === '' || row.disabled === true) return { connections, items }
  const add = (connection: RecoveryConnection, label: string): void => {
    const proof = { name: `${row.name}:${label}`, artifactSha256: owner.artifactSha256,
      entrySha256: owner.entrySha256, configurationSha256: connection.configurationSha256 }
    const itemDigest = recoveryHash(recoveryCanonical(proof))
    const status = approvedItems.has(itemDigest) ? 'approved' : 'eligible'
    items.push({ ...proof, id: itemDigest, itemDigest, kind: 'external-connection', status,
      ...status === 'eligible' ? { reason: 'execution-review-required' } : {} })
    if (status === 'approved') connections.push(connection)
  }
  if (row.name === '@deepseek-ai/dsh-mcp-client' || row.name === '@deepseek-ai/dsh-mcp-manager') {
    const manager = row.name === '@deepseek-ai/dsh-mcp-manager'
    const entries = manager && record(row.config.servers) ? Object.entries(row.config.servers)
      : manager ? [] : [[row.config.serverName, row.config]]
    for (const [serverName, config] of entries) {
      if (typeof serverName !== 'string' || !record(config) || config.enabled === false
        || config.transport !== 'stdio' && config.transport !== 'streamable-http') continue
      const textMap = (value: unknown): value is Record<string, string> => record(value) && Object.values(value).every(item => typeof item === 'string')
      const input: RecoveryMcpInput = {
        serverName, transport: config.transport, expandTemplates: manager || config.expandTemplates === true,
        ...typeof config.command === 'string' ? { command: config.command } : {},
        ...Array.isArray(config.args) && config.args.every(item => typeof item === 'string') ? { args: config.args } : {},
        ...textMap(config.env) ? { env: config.env } : {}, ...typeof config.cwd === 'string' ? { cwd: config.cwd } : {},
        ...typeof config.url === 'string' ? { url: config.url } : {}, ...textMap(config.headers) ? { headers: config.headers } : {} }
      add(recoveryMcpConnection(input), `mcp-${recoveryHash(serverName).slice(0, 12)}`)
    }
  }
  const dialect = row.name === '@deepseek-ai/dsh-hooks-codex' ? 'codex'
    : row.name === '@deepseek-ai/dsh-hooks-claude-code' ? 'claude-code' : undefined
  if (dialect !== undefined && typeof row.config.configPath === 'string') {
    try {
      if (!isAbsolute(row.config.configPath) && cwd === undefined) throw new Error('Missing launch directory')
      const configPath = resolve(cwd ?? '', row.config.configPath), bytes = readFileSync(configPath)
      const raw: unknown = JSON.parse(bytes.toString('utf8')), configSha256 = recoveryHash(bytes)
      const events = record(raw) ? record(raw.hooks) ? raw.hooks : raw : {}
      const points = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', ...dialect === 'claude-code' ? ['SubagentStart', 'SubagentStop'] : []]
      for (const point of points) {
        const groups = events[point]
        if (!Array.isArray(groups)) continue
        for (const group of groups) {
          if (!record(group) || !Array.isArray(group.hooks)) continue
          for (const hook of group.hooks) {
            if (!record(hook) || typeof hook.command !== 'string' || typeof hook.type === 'string' && hook.type !== 'command'
              || dialect === 'codex' && hook.async === true) continue
            let command = hook.command
            if (dialect === 'claude-code') {
              if (typeof row.config.pluginRoot === 'string') command = command.split('${CLAUDE_PLUGIN_ROOT}').join(row.config.pluginRoot)
              if (typeof row.config.projectDir === 'string') command = command.split('${CLAUDE_PROJECT_DIR}').join(row.config.projectDir)
            }
            add(recoveryHookConnection({ dialect, configPath, point, command, configSha256 }), point)
          }
        }
      }
    } catch {
      // An unreadable or nonliteral source cannot authorize any hook commands.
      const id = recoveryHash(`${owner.itemDigest}:hooks-source-unavailable`)
      items.push({ ...owner, id, itemDigest: id, kind: 'external-connection', status: 'suspended', reason: 'hook-source-unavailable' })
    }
  }
  return { connections, items }
}
