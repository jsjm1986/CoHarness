/** Real native Codex requests and durable parent input observed through the SDK. */
import { readFile } from 'node:fs/promises'
import { DeepSeekHarness, validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent-codex'
import { expect, it } from 'vitest'
import { withAuxiliaryModelHarness } from './auxiliary-model-fixture.ts'

it.each(['managed-codex-model', 'managed-codex-member'])('projects every native Codex request and resumes its owner in a fresh process: %s', (directory) => {
  const fixture = new URL(`./fixtures/${directory}/`, import.meta.url)
  return withAuxiliaryModelHarness(fixture, { provider: 'codex-conversation-fixture', model: 'conversation' }, async (harness, options) => {
    let resumedMember: string | undefined
    let resumedRoute: { provider: string; model: string } | undefined
    await harness.start()
    const events = harness.client.subscribeSessionTree('managed-codex-parent')
    const timeout = setTimeout(() => { events.close() }, 60_000)
    try {
      const result = await harness.run('Run managed Codex.', { sessionId: 'managed-codex-parent' })
      expect(result.finalResponse, JSON.stringify({ terminal: result.events.filter(event => event.type === 'turn/end'),
        nativeRequests: result.events.filter(event => event.type === 'subagent/codex-model-request').length })).toBe('PARENT_CODEX_DONE')
      const requests: unknown[] = []
      let completion: unknown
      let memberId: string | undefined
      while (completion === undefined) {
        const notice = await events.next()
        if (notice.method !== 'session.event') continue
        if (notice.params.sessionId !== 'managed-codex-parent') memberId = String(notice.params.sessionId)
        const event = validatedSessionEvent(notice.params.event)
        if (notice.params.sessionId !== 'managed-codex-parent' && event.type === 'request/header') {
          resumedRoute = { provider: event.data.header.config.provider, model: event.data.header.config.model }
        }
        if (event.type === 'subagent/codex-model-request') requests.push({ provider: event.data.provider, model: event.data.model,
          protocol: event.data.request.protocol, bodyModel: event.data.request.body.model })
        const record = pluginRecordOf(event)
        if (record?.type === 'plugin:managed-codex-fixture/complete') completion = record.data
      }
      if (directory === 'managed-codex-member') { expect(memberId).toBeDefined(); resumedMember = memberId }
      expect({ finalResponse: result.finalResponse, requests, completion }).toEqual(JSON.parse(
        await readFile(new URL('expected.json', fixture), 'utf8')))
    } finally { clearTimeout(timeout); events.close() }
    await harness.close()
    const resumed = new DeepSeekHarness({ ...options, ...resumedRoute })
    try {
      const session = await resumed.resumeSession(resumedMember ?? 'managed-codex-parent')
      expect((await session.run('Run managed Codex again.')).finalResponse).toBe(
        resumedMember === undefined ? 'PARENT_CODEX_DONE' : 'MANAGED_CODEX_DONE')
    } finally { await resumed.close() }
  })
}, 120_000)
