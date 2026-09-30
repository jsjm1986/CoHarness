/** Real ACP process with a member workspace distinct from the headless Host cwd. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ExternalBindingStore } from '@deepseek-ai/dsh-subagent/external'
import * as acp from '@deepseek-ai/dsh-subagent-acp/src/index.ts'

export const name = 'external-workspace-fixture'
export const inject = ['llm', 'agents', 'subagents', 'subprocess']

export async function apply(ctx) {
  const workspace = join(process.cwd(), 'requested-member-workspace')
  const stateDir = join(process.cwd(), '.external-state')
  mkdirSync(workspace, { recursive: true })
  await ctx.plugin(acp, {
    command: process.execPath,
    args: ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('../../../../packages/subagent/subagent-acp/tests/mock-acp-server.ts', import.meta.url))],
    resume: true, stateDir, env: { MOCK_LOAD_SESSION: '1', MOCK_ECHO_CWD: '1' },
  })
  class Adapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'External workspace fixture' } }
    listModels(provider) { return Promise.resolve([{ provider, id: 'deepseek-v4-pro', name: 'Workspace probe' }]) }
    async *stream(options) {
      const child = SessionId('external-workspace-child')
      const owner = await ctx.agents.create({ sessionId: child, meta: { cwd: workspace } })
      try {
        if (process.env.EXTERNAL_WORKSPACE_CASE === 'target-moved') {
          const store = new ExternalBindingStore(join(stateDir, 'acp.jsonl'))
          store.assertExecution(child, { cwd: process.cwd(), target: 'local' })
          store.bind(child, 'prior-external-session')
        }
        yield* ctx.llm.stream({ ...options, provider: 'acp-member', model: 'acp', sessionId: child })
      } finally { await owner.dispose() }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['deepseek-official'], new Adapter()))
}
