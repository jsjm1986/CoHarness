/** Ordered center dial candidates: failover and preferred-origin re-probe. */
import { expect, it } from 'vitest'
import { NodeDialer, type NodeDialReason } from '../src/node-dialer.ts'

function fixture(candidates: string[] = ['https://relay.example', 'https://center.example'], preferredRetryMs = 60_000) {
  const events: Array<{ origin: string; reason: NodeDialReason }> = []
  let now = 0
  const dialer = new NodeDialer(candidates, preferredRetryMs,
    (origin, reason) => { events.push({ origin, reason }) }, () => now)
  return { dialer, events, advance: (ms: number) => { now += ms } }
}

it('dials the preferred candidate until a network-level failure advances the list', () => {
  const f = fixture()
  expect(f.dialer.current()).toBe('https://relay.example')
  f.dialer.failed('https://relay.example', new Error('ECONNREFUSED'))
  expect(f.dialer.current()).toBe('https://center.example')
  expect(f.events).toEqual([{ origin: 'https://center.example', reason: 'node-dial/transport-failure' }])
})

it('ignores a stale failure report and never advances past the last candidate', () => {
  const f = fixture(['https://a.example', 'https://b.example'])
  f.dialer.failed('https://a.example', undefined)
  f.dialer.failed('https://a.example', undefined)
  expect(f.dialer.current()).toBe('https://b.example')
  f.dialer.failed('https://b.example', undefined)
  expect(f.dialer.current()).toBe('https://b.example')
  expect(f.events).toHaveLength(1)
})

it('re-probes the preferred candidate once the retry window passed', () => {
  const f = fixture(['https://a.example', 'https://b.example', 'https://c.example'], 60_000)
  f.dialer.failed('https://a.example', undefined)
  f.dialer.failed('https://b.example', undefined)
  expect(f.dialer.current()).toBe('https://c.example')
  f.advance(59_999)
  expect(f.dialer.current()).toBe('https://c.example')
  f.advance(1)
  expect(f.dialer.current()).toBe('https://a.example')
  expect(f.events.at(-1)).toEqual({ origin: 'https://a.example', reason: 'node-dial/preferred-retry' })
  f.dialer.failed('https://a.example', undefined)
  expect(f.dialer.current()).toBe('https://b.example')
  f.advance(60_000)
  expect(f.dialer.current()).toBe('https://a.example')
})

it('never changes the single default candidate', () => {
  const f = fixture(['http://127.0.0.1:3000'])
  f.dialer.failed('http://127.0.0.1:3000', undefined)
  expect(f.dialer.current()).toBe('http://127.0.0.1:3000')
  expect(f.events).toEqual([])
})
