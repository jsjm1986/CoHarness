/** Receipt extraction from inbox events and the persisted prompt proof input. */
import { expect, it } from 'vitest'
import { admittedPrompts } from '../src/prompt-receipts.ts'
import { promptInputJson } from '../src/api/prompt-wire.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { UserDocIdType } from '@deepseek-ai/dsh-userdoc'

function splicedEvent(inserted: { source: Record<string, unknown> }[]): SessionEvent {
  return { type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, removedCount: 0, inserted } } as SessionEvent
}

it('skips inserted sources whose admission fails the receipt schema', () => {
  const malformed = splicedEvent([
    { source: { kind: 'user', admission: { key: 'not-hex', digest: '0'.repeat(64) } } },
  ])
  expect(admittedPrompts(malformed)).toEqual([])
})

it('serializes document parts into the prompt proof input', () => {
  const json = promptInputJson('queue', 'Europe/Berlin', [
    { type: 'text', text: 'summarize' },
    { type: 'document', docId: 'doc-1' as UserDocIdType },
  ])
  expect(JSON.parse(json)).toEqual(['queue', 'Europe/Berlin', [
    { type: 'text', text: 'summarize' },
    { type: 'document', docId: 'doc-1' },
  ]])
})
