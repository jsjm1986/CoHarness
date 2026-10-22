import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { assertFixtureInventory, launchWebScaffold, type WebScaffold } from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/minimal-preset', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const PROMPT = 'Use the bash tool to run exactly: printf \'MINIMAL_BASH_CARD_OK\\n\'. Then reply exactly MINIMAL_PRESET_REQUEST_OK and stop.'

describe('minimal agent preset', () => {
  let scaffold: WebScaffold
  let agentHandle: AgentHandle
  let disposeInjectedPrompt: () => void

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE })
    disposeInjectedPrompt = scaffold.ctx.systemPrompt.section({
      name: 'test:injected-prompt',
      order: 999,
      text: 'THIS TEXT MUST NOT REACH THE MODEL.',
    })
    agentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('minimal-preset-smoke'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'minimal' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await agentHandle?.dispose().catch((error: unknown) => failures.push(error))
    try {
      disposeInjectedPrompt?.()
    } catch (error: unknown) {
      failures.push(error)
    }
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'minimal preset smoke teardown failed')
  })

  it('sends the exact RL prompt and schemas, then executes the persistent shell', async () => {
    agentHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: PROMPT }],
      source: { kind: 'user' },
    }))
    await agentHandle.agent.whenIdle()

    const requestHeader = agentHandle.agent.session.requestHeader()
    if (requestHeader === undefined) throw new Error('the minimal agent issued no model request')
    const runtimeContexts = agentHandle.agent.session.snapshotEvents().flatMap(event => event.type === 'user/message'
      && event.data.source.kind === 'runtime-context'
      ? [event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')]
      : [])
    expect(runtimeContexts).toEqual([
      `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: ${JSON.stringify(agentHandle.agent.session.header.cwd)}.`,
    ])
    // The recorded call ran through the preset's persistent shell: the session
    // committed exactly the replayed `bash` call and its real result.
    const replayedCalls = agentHandle.agent.session.snapshotEvents()
      .flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])
    expect(replayedCalls).toEqual(['bash'])
    const replayedResult = agentHandle.agent.session.snapshotEvents()
      .flatMap(event => event.type === 'tool/result'
        ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
        : [])
      .join('\n')
    expect(replayedResult).toContain('MINIMAL_BASH_CARD_OK')
    expect(replayedResult).toContain('[Command finished with exit code 0]')

    // The preset mounts no filesystem provider or compaction of its own; the
    // shared host services stay out of the mounted subtree's registry reads.
    expect(scaffold.ctx.agentPresets.serviceFor(agentHandle.agent, 'fs')).toBeUndefined()
    expect(scaffold.ctx.agentPresets.serviceFor(agentHandle.agent, 'compaction')).toBeUndefined()

    const stateDir = join(scaffold.workspaceCwd, 'persistent-state')
    await mkdir(stateDir)
    const signal = new AbortController().signal
    await scaffold.ctx.tools.execute({
      signal,
      callId: ToolCallId('minimal-bash-state-setup'),
      name: 'bash',
      arguments: { command: `cd ${JSON.stringify(stateDir)} && export DSH_MINIMAL_STATE=PERSISTED` },
      agent: agentHandle.agent,
    })
    const bash = await scaffold.ctx.tools.execute({
      signal,
      callId: ToolCallId('minimal-bash-state-read'),
      name: 'bash',
      arguments: { command: 'printf \'%s:%s\n\' "$DSH_MINIMAL_STATE" "$PWD"' },
      agent: agentHandle.agent,
    })

    const text = (result: typeof bash): string => result.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .replaceAll(scaffold.workspaceCwd, '{{cwd}}')
      .trimEnd()

    const systemPrompt = agentHandle.agent.session.snapshotEvents()
      .filter((event): event is Extract<typeof event, { type: 'system/message' }> => event.type === 'system/message')
      .flatMap(event => event.data.message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')

    expect({
      prompt: systemPrompt,
      tools: requestHeader.tools?.map(tool => tool.name),
      bash: text(bash),
    }).toMatchInlineSnapshot(`
      {
        "bash": "PERSISTED:{{cwd}}/persistent-state
      [Command finished with exit code 0]",
        "prompt": "You are a helpful software engineer assistant.",
        "tools": [
          "bash",
          "working_directory",
        ],
      }
    `)
    expect(requestHeader.tools?.toSorted((left, right) => left.name.localeCompare(right.name)))
      .toEqual(scaffold.ctx.tools.schemas(agentHandle.agent).toSorted((left, right) => left.name.localeCompare(right.name)))
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl'])
  })
})
