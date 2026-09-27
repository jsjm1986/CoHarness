/** Seed realization preserves identity relationships and valid JSON across host paths. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { realizeSeedFixture, selectedSessionFixture } from '../apps/web/tests/scaffold.ts'

const target = { workspaceCwd: 'C:\\work\\"quoted"', harnessHome: 'C:\\home\\harness' }

it('realizes typed parent, child and resource identities without changing literal business text', () => {
  const input = [
    { type: 'session', id: '{{session:1}}', cwd: '{{cwd}}' },
    { type: 'fixture', parent: '{{session:1}}', child: '{{session:10}}', other: '{{session:2}}',
      message: '{{message:1}}', again: '{{message:1}}', second: '{{message:2}}',
      principal: '{{principal:1}}', runtime: '{{runtime:1}}', home: '{{harnessHome}}',
      text: 'order 123e4567-e89b-12d3-a456-426614174000 expires 2026-09-25T12:34:56Z; "sleep 45s"' },
  ].map(record => JSON.stringify(record)).join('\n') + '\n'
  const realized = realizeSeedFixture(target, input, 'parent')
  const [header, event] = realized.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  if (header === undefined || event === undefined) throw new Error('realized seed fixture lacks header or event lines')
  expect(header).toEqual({ type: 'session', id: 'parent', cwd: target.workspaceCwd })
  expect(event).toMatchObject({ parent: 'parent', child: 'parent-child-10', other: 'parent-child-2', home: target.harnessHome })
  expect(event['message']).toBe(event['again'])
  expect(event['message']).not.toBe(event['second'])
  expect(event['principal']).not.toBe(event['runtime'])
  const sourceLine = input.trim().split('\n').at(1)
  if (sourceLine === undefined) throw new Error('seed fixture input lacks the event line')
  expect(event['text']).toBe((JSON.parse(sourceLine) as Record<string, unknown>)['text'])
  expect(realizeSeedFixture(target, realized, 'parent')).toBe(realized)
})

it('selects the highest generation for the requested role without touching predecessor bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'web-seed-generation-'))
  const v3 = '{"type":"session","version":3}\n'
  const v6 = '{"type":"session","version":6}\n'
  try {
    await writeFile(join(root, 'session.v3.jsonl'), v3)
    await writeFile(join(root, 'session.v6.jsonl'), v6)
    await writeFile(join(root, 'session.1.v3.jsonl'), v3)
    expect(await selectedSessionFixture(join(root, 'session.v3.jsonl'))).toBe(join(root, 'session.v6.jsonl'))
    expect(await selectedSessionFixture(join(root, 'session.1.v3.jsonl'))).toBe(join(root, 'session.1.v3.jsonl'))
    expect(await readFile(join(root, 'session.v3.jsonl'), 'utf8')).toBe(v3)
    await writeFile(join(root, 'session.v6.jsonl'), v3)
    await expect(selectedSessionFixture(join(root, 'session.v3.jsonl'))).rejects.toThrow()
    await expect(selectedSessionFixture(join(root, 'session.2.v3.jsonl'))).rejects.toThrow('missing Session fixture role')
    expect(await selectedSessionFixture(join(root, 'literal.txt'))).toBe(join(root, 'literal.txt'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
