import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it } from 'vitest'
import { DocumentProjectionDelivery } from '../src/document-projection-delivery.ts'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('document projection delivery', () => {
  it('retains a cursor read through acknowledgement while another root progresses independently', async () => {
    const held = barrier(), release = barrier(), root = new DocumentProjectionDelivery(), other = new DocumentProjectionDelivery()
    const authority = new AsyncLocalStorage<string>(), events: string[] = []
    let cursor = 0, acknowledged = 0
    const deliver = async () => {
      const after = cursor
      events.push(`read:${authority.getStore()}:${after}`)
      if (after === 0) { held.resolve(); await release.promise }
      if (after < acknowledged) throw new Error('The catalog checkpoint precedes the retained document projection.')
      cursor += 1
      acknowledged = cursor
      events.push(`ack:${authority.getStore()}:${acknowledged}`)
    }
    const first = authority.run('first', () => root.run(deliver))
    await held.promise
    const second = authority.run('second', () => root.run(deliver))
    const settled = Promise.allSettled([first, second])
    try {
      await other.run(async () => { events.push('other-root') })
      expect(events).toEqual(['read:first:0', 'other-root'])
      release.resolve()
      expect((await settled).map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
      expect(events).toEqual(['read:first:0', 'other-root', 'ack:first:1', 'read:second:1', 'ack:second:2'])
    } finally { release.resolve(); await settled; await Promise.all([root.close(), other.close()]) }
  })

  it('preserves each failure and caller authority while draining accepted work before close', async () => {
    const root = new DocumentProjectionDelivery(), entered = barrier(), release = barrier()
    const failure = new Error('receiver refused the original actor'), authority = new AsyncLocalStorage<string>()
    const events: string[] = []
    const first = authority.run('revoked', () => root.run(async () => {
      entered.resolve(); await release.promise; throw failure
    }))
    await entered.promise
    const second = authority.run('allowed', () => root.run(async () => { events.push(authority.getStore()!) }))
    const settled = Promise.allSettled([first, second])
    const closed = root.close().then(() => { events.push('closed') })
    try {
      await expect(root.run(async () => { events.push('late') })).rejects.toMatchObject({ code: 'DOCUMENT_STORE_UNAVAILABLE' })
      expect(events).toEqual([])
      release.resolve()
      expect(await settled).toEqual([{ status: 'rejected', reason: failure }, { status: 'fulfilled', value: undefined }])
      await closed
      expect(events).toEqual(['allowed', 'closed'])
    } finally { release.resolve(); await settled; await closed }
  })
})
