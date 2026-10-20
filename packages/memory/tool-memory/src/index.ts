/**
 * `@deepseek-ai/dsh-tool-memory` — the four model-facing memory tools
 * (`memory_search`, `memory_read`, `memory_save`, `memory_delete`) plus the
 * `tool:memory` system-prompt guidance section. Refusals surface as thrown
 * `HarnessError` subclasses with stable codes so ToolRuntime exposes
 * `{ name, code }`; a project-write authority denial rethrows the
 * `execution/forbidden` RemoteError with the model-facing message.
 * @module @deepseek-ai/dsh-tool-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Registers 'execution/forbidden' in RemoteErrorDetailsMap for the rethrow below.
import type {} from '@deepseek-ai/dsh-execution-authority'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  MemoryRevision,
  type MemoryKind,
  type MemoryRefusalCode,
  type MemoryScope,
  type MemoryWriteResult,
} from '@deepseek-ai/dsh-memory'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import {
  defineTool,
  type ParameterPropertySpec,
  type ToolResult,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'

export const name = 'tool-memory'
export const inject = ['memory', 'tools', 'systemPrompt']

/** Plugin configuration: no fields today; the schema validates an empty object. */
export interface Config {}

/** Validate the (currently empty) plugin configuration. */
export const Config: z<Config> = z.object({})

const SCOPE_DESCRIPTION = 'personal: facts about the user that apply in every workspace. workspace: facts specific to this conversation\'s working directory.'
const SCOPE_SEARCH_DESCRIPTION = `Search only this scope; omit to search every scope. ${SCOPE_DESCRIPTION}`

/** The scope argument shape every two-scope tool accepts; absent in single-scope spaces. */
interface ScopedArgs { scope?: 'personal' | 'workspace' }

/** Validated arguments shared by the mutating tools. */
interface WriteArgs extends ScopedArgs { key: string; revision?: string }

/** A service refusal or validation failure rendered for the model; `code` is the stable refusal class. */
export class MemoryToolError extends HarnessError {
  // oxlint-disable-next-line no-useless-constructor -- narrows HarnessError's `code: string` to the refusal union.
  constructor(message: string, code: MemoryRefusalCode) {
    super(message, code)
  }
}

/**
 * Register the four memory tools and the `tool:memory` guidance section. The
 * `scope` parameter exists only in the two-scope personal space; in project
 * space every tool addresses `{ kind: 'project' }` implicitly.
 */
export function apply(ctx: Context): void {
  const twoScopes = ctx.memory.space === 'personal'
  const scopeSuffix = (kind: string | undefined): string =>
    twoScopes && kind !== undefined ? ` in the ${kind} scope` : ''
  const scopeFrom = (kind: string | undefined): string =>
    twoScopes && kind !== undefined ? ` from the ${kind} scope` : ''

  /**
   * Resolve the model's `scope` argument into a concrete MemoryScope via
   * `scopesFor(exec.agent)`. Missing agent throws the fixed wiring error;
   * `workspace` without a session workspace is `scope-unavailable`.
   */
  const resolveScope = (args: ScopedArgs, exec: ToolRunContext): { agent: Agent; scope: MemoryScope } => {
    const agent = exec.agent
    if (agent === undefined) throw new Error('memory tools require a calling agent')
    if (!twoScopes) return { agent, scope: { kind: 'project' } }
    if (args.scope === 'workspace') {
      const workspace = ctx.memory.scopesFor(agent).find(candidate => candidate.kind === 'workspace')
      if (workspace === undefined) {
        throw new MemoryToolError(
          'This conversation has no working directory, so the workspace scope is unavailable.',
          'memory_invalid',
        )
      }
      return { agent, scope: workspace }
    }
    return { agent, scope: { kind: 'personal' } }
  }

  /** Render a service refusal as the thrown model-facing error for this tool call. */
  const refusalOf = (result: MemoryWriteResult & { ok: false }, args: WriteArgs, scope: MemoryScope): MemoryToolError => {
    const suffix = scopeSuffix(scope.kind)
    switch (result.code) {
      case 'memory_exists':
        return new MemoryToolError(
          `A memory with the key "${args.key}" already exists${suffix}. Read it with memory_read and pass its revision to replace it, or choose another key.`,
          'memory_exists',
        )
      case 'memory_not_found':
        return new MemoryToolError(`No saved memory has the key "${args.key}"${suffix}.`, 'memory_not_found')
      case 'memory_stale': {
        /* v8 ignore next -- the service only refuses with memory_stale when the caller supplied a revision */
        const revision = args.revision ?? ''
        return new MemoryToolError(
          `The memory "${args.key}" changed after revision ${revision}. Read it again with memory_read before changing it.`,
          'memory_stale',
        )
      }
      case 'memory_full':
        return new MemoryToolError(
          `This memory scope already holds ${ctx.memory.limits.maxEntriesPerScope} memories. Delete or merge memories that are no longer useful before saving a new one.`,
          'memory_full',
        )
      case 'memory_invalid':
        switch (result.reason) {
          case 'key':
            return new MemoryToolError(
              `The key "${args.key}" is invalid: use lowercase letters, digits, and single hyphens, at most 64 characters.`,
              'memory_invalid',
            )
          case 'summary':
            return new MemoryToolError(
              `The summary must be one line of 1 to ${ctx.memory.limits.summaryMaxChars} characters.`,
              'memory_invalid',
            )
          case 'content':
            return new MemoryToolError(
              `The content must not be empty and must fit in ${ctx.memory.limits.entryMaxBytes} bytes of UTF-8.`,
              'memory_invalid',
            )
          case 'scope-unavailable':
            return new MemoryToolError(
              'This conversation has no working directory, so the workspace scope is unavailable.',
              'memory_invalid',
            )
          case 'workspace-mismatch':
            return new MemoryToolError(
              'This conversation can change only the workspace memory of its own working directory.',
              'memory_invalid',
            )
          default:
            return new MemoryToolError('The memory request was invalid.', 'memory_invalid')
        }
    }
  }

  /**
   * Run one write call: authority denials on project writes rethrow a
   * `execution/forbidden` RemoteError carrying the model-facing refusal;
   * ordinary refusals become {@link MemoryToolError}s.
   */
  const runWrite = async (
    write: () => Promise<MemoryWriteResult>,
    args: WriteArgs,
    scope: MemoryScope,
  ): Promise<MemoryWriteResult & { ok: true }> => {
    let result: MemoryWriteResult
    try {
      result = await write()
    } catch (error: unknown) {
      const remote = remoteErrorOf(error)
      if (remote?.code === 'execution/forbidden') {
        throw new RemoteError('execution/forbidden',
          'Changing project memory is not permitted in this conversation. An administrator must enable memory writing for this project and for every participant, and private conversations can only read project memory.',
          { capability: 'memory' },
          { cause: error })
      }
      throw error
    }
    if (!result.ok) throw refusalOf(result, args, scope)
    return result
  }

  /** The shared `scope` parameter spec; `required` is omitted (never `false`) for the optional search filter. */
  const scopeParam = (required: boolean, description = SCOPE_DESCRIPTION): ParameterPropertySpec => ({
    type: 'string',
    enum: ['personal', 'workspace'],
    ...(required ? { required: true } : {}),
    description,
  })

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Search saved memories by words in their key, summary, or content. Returns matching memories ranked by relevance, each with a short excerpt. Read a memory with memory_read before relying on its details.',
    parameters: {
      query: { type: 'string', required: true, description: 'Words to look for; matching ignores case.' },
      ...(twoScopes ? { scope: scopeParam(false, SCOPE_SEARCH_DESCRIPTION) } : {}),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                updated: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                excerpt: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.hits.length === 0
          ? `No saved memory matches "${args.query}".`
          : [
            `<memory_search query="${escapeXml(args.query)}">`,
            ...value.hits.flatMap(hit => [
              `- \`${hit.key}\`${twoScopes ? ` (${hit.scope})` : ''} [${hit.kind}, ${hit.updated}]: ${escapeXml(hit.summary)}`,
              `  ${escapeXml(hit.excerpt)}`,
            ]),
            '</memory_search>',
          ].join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args: ScopedArgs & { query: string }, exec) {
      const { agent, scope } = resolveScope(args, exec)
      const scopes = twoScopes && args.scope === undefined
        ? ctx.memory.scopesFor(agent)
        : [scope]
      const result = await ctx.memory.search(scopes, args.query)
      if (!Array.isArray(result)) {
        throw new MemoryToolError('The query must contain at least one word.', 'memory_invalid')
      }
      return {
        hits: result.map(hit => ({
          key: hit.entry.key,
          scope: hit.entry.scope.kind,
          kind: hit.entry.kind,
          updated: hit.entry.updated.at.slice(0, 10),
          summary: hit.entry.summary,
          excerpt: hit.excerpt,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: 'Read one saved memory in full, including the revision that memory_save and memory_delete use to change it.',
    parameters: {
      ...(twoScopes ? { scope: scopeParam(true) } : {}),
      key: { type: 'string', required: true, description: 'Key of the memory, as listed in the saved-memory catalog or by memory_search.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', required: true },
          key: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          updated: { type: 'string', required: true },
          revision: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `<memory key="${value.key}"${twoScopes ? ` scope="${value.scope}"` : ''} kind="${value.kind}" updated="${value.updated}" revision="${value.revision}">`,
          value.content,
          '</memory>',
        ].join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args: ScopedArgs & { key: string }, exec) {
      const { scope } = resolveScope(args, exec)
      const entry = await ctx.memory.read(scope, args.key)
      if (entry === undefined) {
        throw new MemoryToolError(`No saved memory has the key "${args.key}"${scopeSuffix(scope.kind)}.`, 'memory_not_found')
      }
      return {
        scope: entry.scope.kind,
        key: entry.key,
        kind: entry.kind,
        updated: entry.updated.at.slice(0, 10),
        revision: entry.revision,
        content: entry.content,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_save',
    description: 'Save a memory that later conversations will see in their saved-memory catalog. Without a revision this creates a new memory and fails if the key is already used. To change an existing memory, read it with memory_read and pass its revision; the content you send replaces the old content entirely.',
    parameters: {
      ...(twoScopes ? { scope: scopeParam(true) } : {}),
      key: { type: 'string', required: true, description: 'Stable identifier made of lowercase letters, digits, and single hyphens, at most 64 characters, for example "release-freeze".' },
      kind: { type: 'string', enum: ['profile', 'guidance', 'background', 'resource'], required: true, description: 'profile: who the user or team is — role, expertise, preferences. guidance: how you should work — a correction or a confirmed approach, with the reason. background: goals, constraints, decisions, or deadlines that the code and its history do not show. resource: where to find information outside the workspace, such as a dashboard, tracker, or document.' },
      summary: { type: 'string', required: true, description: `One line of at most ${ctx.memory.limits.summaryMaxChars} characters, specific enough to judge from the catalog alone whether this memory is relevant.` },
      content: { type: 'string', required: true, description: 'The memory in Markdown. For guidance and background, state the rule or fact, then a "Why:" line and a "How to apply:" line. Write dates as absolute dates.' },
      revision: { type: 'string', description: 'Revision returned by memory_read; required to replace an existing memory.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', required: true },
          key: { type: 'string', required: true },
          operation: { type: 'string', required: true, enum: ['create', 'update'] },
          revision: { type: 'string', required: true },
          previousContent: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.operation === 'create' ? 'Created' : 'Updated'} memory "${value.key}"${scopeSuffix(value.scope)} (revision ${value.revision}).`,
      }],
      presentationMeta: (_args, value) => ({
        path: `memory/${value.scope}/${value.key}`,
        oldText: value.previousContent,
        newText: value.content,
      }),
    },
    async execute(args: WriteArgs & { kind: MemoryKind; summary: string; content: string }, exec) {
      const { agent, scope } = resolveScope(args, exec)
      const result = await runWrite(() => ctx.memory.save({
        scope,
        key: args.key,
        kind: args.kind,
        summary: args.summary,
        content: args.content,
        ...(args.revision !== undefined ? { expectedRevision: MemoryRevision(args.revision) } : {}),
      }, { kind: 'agent', agent, signal: exec.signal }), args, scope)
      return {
        scope: scope.kind,
        key: result.entry.key,
        operation: result.operation === 'create' ? 'create' as const : 'update' as const,
        revision: result.entry.revision,
        previousContent: result.previous?.content ?? null,
        content: result.entry.content,
      }
    },
    presentCall: args => ({
      card: 'diff',
      title: `Save memory ${args.key}`,
      diffs: [{
        path: `memory/${(args as ScopedArgs).scope ?? 'project'}/${args.key}`,
        oldText: null,
        newText: args.content,
      }],
    }),
    presentResult: (args, result: ToolResult) => {
      if (result.isError) return undefined
      const meta = result.meta as { path?: string; oldText?: string | null; newText?: string } | undefined
      return {
        card: 'diff',
        title: `Save memory ${args.key}`,
        diffs: [{
          path: meta?.path ?? `memory/${(args as ScopedArgs).scope ?? 'project'}/${args.key}`,
          oldText: meta?.oldText ?? null,
          newText: meta?.newText ?? args.content,
        }],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_delete',
    description: 'Delete a saved memory that is wrong or no longer useful. Pass the revision from memory_read when you have one, so that a newer change is not deleted by mistake.',
    parameters: {
      ...(twoScopes ? { scope: scopeParam(true) } : {}),
      key: { type: 'string', required: true, description: 'Key of the memory to delete.' },
      revision: { type: 'string', description: 'Revision returned by memory_read; when given, the memory is deleted only if it has not changed since.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', required: true },
          key: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Deleted memory "${value.key}"${scopeFrom(value.scope)}.`,
      }],
    },
    async execute(args: WriteArgs, exec) {
      const { agent, scope } = resolveScope(args, exec)
      const result = await runWrite(() => ctx.memory.delete({
        scope,
        key: args.key,
        ...(args.revision !== undefined ? { expectedRevision: MemoryRevision(args.revision) } : {}),
      }, { kind: 'agent', agent, signal: exec.signal }), args, scope)
      return { scope: scope.kind, key: result.entry.key }
    },
  }))

  // Guidance text: registered after the tools so reverse teardown removes it
  // first. The section renders only when `memory_save` resolves for the
  // requesting scope, mirroring tool-write's visibility check.
  ctx.systemPrompt.section({
    name: 'tool:memory',
    order: ctx.systemPrompt.getSectionOrder('TOOL_MEMORY'),
    text: ({ scope }) => ctx.tools.get('memory_save', scope) === undefined
      ? ''
      : [
        'Saved memories carry knowledge between conversations. The saved-memory catalog in this conversation lists them by key with one-line summaries; memory_search, memory_read, memory_save, and memory_delete manage them.',
        '',
        'Save a memory when you learn something that will matter in later conversations and cannot be recovered from the workspace: who the user is and how they like to work (profile); a correction or a confirmed approach to how you should work, with the reason (guidance); goals, constraints, decisions, or deadlines that the code and its history do not show (background); where to find information outside the workspace (resource). When the user asks you to remember something, save it; when they ask you to forget something, delete it.',
        '',
        'Do not save what you can read from the workspace — code structure, file paths, conventions, git history, or fixes already in the code — what AGENTS.md files already say, or details that only matter to the current task. Never save secrets, credentials, or tokens.',
        '',
        'Before saving, check the catalog or memory_search for a memory that already covers the fact and update it instead of adding a near-duplicate. Delete memories that turn out to be wrong.',
        '',
        'A memory records what was true when it was written. Before acting on a memory\'s claim about files, functions, or flags, check the current workspace, and update or delete the memory if it no longer holds.',
        '',
        ctx.memory.space === 'personal'
          ? 'Use the personal scope for facts about the user that apply in every workspace, and the workspace scope for facts specific to this conversation\'s working directory.'
          : 'Project memories are shared with every member of this project. Save what will help the team\'s later conversations, and write each memory so that someone who did not see this conversation understands it.',
      ].join('\n'),
  })
}

/** XML-escape `&`, `<`, `>`, `"` in rendered search text (frame-local, never stored). */
function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
