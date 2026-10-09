/**
 * Steward maintenance tools for the reserved resident runtime. The plugin
 * mounts one `steward_query` tool that reaches the Gateway's audited SQL
 * channel over the runtime's own loopback credential. Statements classified
 * as writes first ask the operator in-session; the granted approval id is
 * recovered from the `approval/asked` session event and passed to the Gateway,
 * which re-verifies it server-side before executing.
 * @module @deepseek-ai/dsh-steward-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GatewayRuntime } from '@deepseek-ai/dsh-gateway-runtime'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { isReadOnly, statementPreview } from './query.ts'

export const name = 'dsh-steward-tools'
export const inject = ['tools', 'gatewayRuntime']

const TOOL = 'steward_query'
const MAX_ROW_LIMIT = 5_000

interface StewardQueryArgs {
  sql: string
  dry_run?: boolean
  row_limit?: number
}

interface StewardQueryWire {
  classification: 'read' | 'write'
  dryRun: boolean
  columns: string[]
  rows: unknown[] | null
  plan: unknown[] | null
  rowCount: number | null
  truncated: boolean
}

function argsOf(exec: ToolExecution): StewardQueryArgs | undefined {
  const args = typeof exec.arguments === 'object' && exec.arguments !== null
    ? exec.arguments as Record<string, unknown>
    : undefined
  if (typeof args?.sql !== 'string') return undefined
  const out: StewardQueryArgs = { sql: args.sql }
  if (args.dry_run === true) out.dry_run = true
  if (typeof args.row_limit === 'number') out.row_limit = args.row_limit
  return out
}

/** Approval ids keyed by owning session so entries die with their session. */
type ApprovalIndex = Map<Session, Map<string, string>>

function approvalKey(callId: unknown): string {
  return String(callId)
}

function renderResult(result: StewardQueryWire): string {
  if (result.dryRun) {
    const plan = (result.plan ?? []).map(row => JSON.stringify(row)).join('\n')
    return `Dry run plan:\n${plan}`
  }
  const suffix = result.truncated ? '\n(result truncated — raise row_limit or narrow the statement)' : ''
  if (result.rows === null) {
    return `Statement applied; ${String(result.rowCount ?? 0)} row(s) affected.${suffix}`
  }
  return `Columns: ${result.columns.join(', ') || '(none)'}\nRows (${String(result.rows.length)}):\n${result.rows.map(row => JSON.stringify(row)).join('\n')}${suffix}`
}

/**
 * Mount the steward tool surface: one audited SQL tool plus a pre-execute
 * listener that routes write statements through the session approval channel.
 * @param ctx - registrant context providing `tools` and `gatewayRuntime`.
 */
export function apply(ctx: Context): void {
  const gateway: GatewayRuntime = ctx.gatewayRuntime
  const approvals: ApprovalIndex = new Map()
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'approval/asked') return
    const data = event.data as { id?: unknown; callId?: unknown }
    if (data.id === undefined || data.callId === undefined) return
    let per = approvals.get(session)
    if (per === undefined) {
      per = new Map()
      approvals.set(session, per)
    }
    per.set(approvalKey(data.callId), String(data.id))
  }, { global: true })
  ctx.on('session/disposed', (session) => {
    approvals.delete(session)
  }, { global: true })
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    if (exec.name !== TOOL) return next()
    const args = argsOf(exec)
    // Malformed input delegates; the parameter schema rejects it later in the
    // same pipeline. A dry-run EXPLAIN never executes the statement.
    if (args === undefined || isReadOnly(args.sql) || args.dry_run === true) return next()
    return { kind: 'ask', reason: `steward write statement: ${statementPreview(args.sql)}` }
  })
  ctx.tools.register(defineTool({
    name: TOOL,
    description:
      'Run one audited SQL statement against the deployment database. SELECT-family statements '
      + 'run directly; statements that write, alter, or administer first ask the operator for '
      + 'approval in this conversation. Use dry_run to preview a statement plan without applying it. '
      + 'Prefer a LIMIT or a narrow row_limit for large result sets.',
    parameters: {
      sql: {
        type: 'string',
        required: true,
        description: 'A single SQL statement. Multi-statement input is rejected.',
      },
      dry_run: {
        type: 'boolean',
        description: 'When true, return the EXPLAIN plan without executing the statement.',
      },
      row_limit: {
        type: 'integer',
        description: `Maximum rows to return for read statements (default 500, at most ${String(MAX_ROW_LIMIT)}).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(rawArgs, exec) {
      const args = rawArgs as StewardQueryArgs
      const write = !isReadOnly(args.sql) && args.dry_run !== true
      let approvalId: string | undefined
      if (write) {
        // The pre-execute ask resolved before this body ran; the approved
        // interaction id is the executor-side proof the Gateway re-verifies.
        approvalId = exec.agent === undefined
          ? undefined
          : approvals.get(exec.agent.session)?.get(approvalKey(exec.callId))
        if (approvalId === undefined) {
          throw new Error('steward_query write statements require an in-session approval that did not resolve')
        }
      }
      const response = await gateway.request('/internal/runtime/steward/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sql: args.sql,
          dryRun: args.dry_run === true,
          ...(typeof args.row_limit === 'number' ? { rowLimit: Math.min(args.row_limit, MAX_ROW_LIMIT) } : {}),
          ...(approvalId === undefined ? {} : { approvalId }),
        }),
      })
      const payload: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const message = typeof payload === 'object' && payload !== null && 'message' in payload
          ? String((payload as { message: unknown }).message)
          : `steward query failed (${String(response.status)})`
        throw new Error(message)
      }
      return { text: renderResult(payload as StewardQueryWire) }
    },
    presentCall: args => ({
      card: 'generic',
      title: typeof args === 'object' && args !== null && (args as { dry_run?: unknown }).dry_run === true
        ? 'Preview maintenance statement' : 'Run maintenance statement',
      kind: 'other',
      rawInput: args,
    }),
  }))
}
