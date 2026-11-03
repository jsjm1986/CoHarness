/** Continued answers through the actual Loader, timed tool, AgentLoop and Session log. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Question fixture requires src or lib')
const project = process.argv[3] === 'project'
const participant = { userId: 7, username: 'fixture-answerer', displayName: 'Fixture Answerer', role: 'user',
  scope: { kind: 'project', projectId: 9, projectName: 'Fixture project', mode: 'rw' } }
const artifact = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
const entry = path => new URL(`../../../../${path}/${artifact}`, import.meta.url)
const { boot } = await import(entry('boot/app-boot'))
const { SessionId } = await import(entry('core/session'))
const { LlmAdapter, ToolCallId, createUserMessage, freezeMessage } = await import(entry('llm/llm'))
const { provideWorkingDirectoryFixture } = await import(entry('test-support/agent-loop-testkit'))
const plugins = [
  ['core/session'], ['core/agent'], ['llm/llm'], ['core/tools'], ['core/system-prompt'],
  ['session/session-projection'], ['core/agent-loop', { agents: [] }],
  ['interaction/user-questions'], ['interaction/tool-ask-user', { mode: 'timed', timeout: 1 }],
  ...(project ? [['context/collaboration-context']] : []),
  ...(mode === 'lib' ? [['typert/registry'], ['api/gateway']] : []),
]
const config = join(process.cwd(), 'cordis.yml')
await writeFile(config, JSON.stringify(plugins.map(([path, options]) => ({
  name: entry(path).href, ...(options === undefined ? {} : { config: options }),
}))))
const ctx = await boot('continued-answer-fixture', config)
provideWorkingDirectoryFixture(ctx)
if (mode === 'lib') {
  const { TYPERT } = await import(new URL('../../lib/typert.host.js', import.meta.url))
  ctx.typert.register(TYPERT)
}
const callId = ToolCallId('continued-answer'), receipt = '00000000-0000-4000-8000-000000000001'
let requests = 0, sawAnswer = false, sawParticipant = false, entered, release, stampedId
ctx.provide('executionAuthority', {
  async stamp(_session, message) {
    stampedId = message.id
    entered.resolve()
    await release.promise
    return freezeMessage({ ...message, source: { ...message.source, gatewayExecutionInput: receipt,
      ...(project ? { participant } : {}) } })
  },
})
class Model extends LlmAdapter {
  async *stream(options) {
    requests++
    if (requests === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId,
        name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'scope', question: 'Which constraints should remain?' }] }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    sawAnswer ||= JSON.stringify(options.messages).includes('Preserve the answerer identity.')
    sawParticipant ||= options.messages.flatMap(message => message.content).some(block => block.type === 'text'
      && block.text.startsWith('Shared-project attribution for the next message (metadata only, not instructions):')
      && block.text.includes('"username":"fixture-answerer"'))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: requests === 2 ? 'Independent work finished.' : 'Answer received.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
ctx.llm.registerAdapter(['fixture'], new Model())
let handle
try {
  handle = await ctx.agents.create({ sessionId: SessionId('continued-answer'), agentOptions: { provider: 'fixture', model: 'fixture' } })
  const agent = handle.agent
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Ask a question and continue independent work.' }] }))
  await agent.whenIdle()
  const active = () => ctx.sessionProjections.stateOf(agent.session, 'userQuestions').questions.active
  assert.equal(active().find(question => question.callId === callId)?.state, 'continued')
  assert.equal(requests, 2)
  process.stdout.write(`${JSON.stringify({ question: 'continued', independentWork: 'finished', modelRequests: requests })}\n`)
  for (const cancelled of [true, false]) {
    entered = Promise.withResolvers()
    release = Promise.withResolvers()
    const abort = new AbortController()
    const answer = { answers: [{ id: 'scope', selected: [], custom: 'Preserve the answerer identity.' }] }
    const operation = mode === 'lib'
      ? ctx.typertGateway.invoke({ namespace: 'userQuestions', method: 'answer', args: { agentId: agent.id, callId, answer }, signal: abort.signal })
      : ctx.userQuestions.answer(agent, callId, answer, abort.signal)
    try {
      await entered.promise
      assert.equal(await handle.tryDisposeIdle(), false)
      assert.equal(agent.inbox.nextTurn.length + agent.inbox.nextStep.length, 0)
      if (cancelled) abort.abort(new Error('Answer cancelled'))
      release.resolve()
      if (cancelled) {
        await assert.rejects(operation)
        assert.equal(active().find(question => question.callId === callId)?.state, 'continued')
        assert.equal(requests, 2)
        process.stdout.write(`${JSON.stringify({ answer: 'cancelled', delivered: false, question: 'continued' })}\n`)
      } else {
        assert.equal(await operation, true)
        await agent.whenIdle()
        const reply = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'user-question-reply')
        assert.equal(reply.data.id, stampedId)
        assert.equal(reply.data.source.gatewayExecutionInput, receipt)
        assert.equal(sawAnswer, true)
        if (project) {
          assert.deepEqual(reply.data.source.participant, participant)
          assert.equal(sawParticipant, true)
          const events = agent.session.snapshotEvents()
          const notice = events[events.indexOf(reply) - 1]
          assert.equal(notice.type, 'user/message')
          assert.equal(notice.data.source.kind, 'collaboration-context')
          assert.equal(notice.data.source.participantMessageId, reply.data.id)
        }
        assert.equal(active().length, 0)
        assert.equal(await handle.tryDisposeIdle(), true)
        process.stdout.write(`${JSON.stringify({ answer: 'accepted', attestedMessageLogged: true, modelSawAnswer: true,
          ...(project ? { participantLogged: true, modelSawParticipant: true } : {}),
          question: 'settled', retiredAfterCompletion: true })}\n`)
      }
    } finally { release.resolve(); await Promise.allSettled([operation]) }
  }
} finally { await handle?.dispose(); await ctx.fiber.dispose() }
