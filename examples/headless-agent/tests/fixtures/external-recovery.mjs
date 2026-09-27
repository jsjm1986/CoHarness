/** Persisted external evidence fixture; the provider and headless application are real. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExternalBindingStore, externalPromptWindow } from '@deepseek-ai/dsh-subagent/external'
import { CodexMemberAdapter, CodexMemberTransport } from '@deepseek-ai/dsh-subagent-codex/src/member.ts'

export const name = 'external-recovery-fixture'
export const inject = ['llm']

export function apply(ctx) {
  const root = join(process.cwd(), '.external-fixture')
  const store = new ExternalBindingStore(join(root, 'bindings.jsonl'))
  const transport = new CodexMemberTransport({ cwd: process.cwd(), permissionMode: 'never',
    env: { CODEX_HOME: root }, disposeGraceMs: 100 }, () => { throw new Error('Recovery must not start another external turn') })
  class Adapter extends CodexMemberAdapter {
    prepared = false
    stream(options) {
      if (!this.prepared) {
        this.prepared = true
        const window = externalPromptWindow(options.messages)
        if (window === undefined || options.sessionId === undefined) throw new Error('Fixture requires a real entered request')
        store.bind(options.sessionId, 'fixture-thread')
        store.markPending(options.sessionId, { ...window, externalTurnId: 'fixture-turn' })
        const complete = process.env.EXTERNAL_RECOVERY_CASE === 'complete'
        const text = complete ? 'EXTERNAL_TURN_RECOVERED' : 'I have only started the operation.'
        const entries = [
          { type: 'event_msg', payload: { type: 'task_started', turn_id: 'fixture-turn' } },
          { type: 'event_msg', payload: { type: 'user_message', message: window.prompt } },
          { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: complete ? 'final_answer' : 'commentary', content: [{ type: 'output_text', text }] } },
          ...complete ? [{ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'fixture-turn', last_agent_message: text } }] : [],
        ]
        mkdirSync(join(root, 'sessions'), { recursive: true })
        writeFileSync(join(root, 'sessions', 'rollout-fixture-thread.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
      }
      return super.stream(options)
    }
  }
  ctx.llm.registerAdapter(['deepseek-official'], new Adapter(transport, store))
}
