/** Audit-log durability: the tail reload tolerates crash-truncated rows instead of failing the capability at load. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VncAuditLog } from '../src/audit.ts'

let dir: string | undefined
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

const logger = () => ({ warn: vi.fn() })

describe('VncAuditLog', () => {
  it('skips a crash-truncated tail row instead of failing the capability at load', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-desktop-audit-'))
    const file = join(dir, 'audit.jsonl')
    const warn = vi.fn()
    await writeFile(file, '{"kind":"con', 'utf8')
    const reopened = await VncAuditLog.open(file, 1024, { warn })
    expect(reopened.all()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('keeps readable rows when only the newest line is corrupt', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-desktop-audit-'))
    const file = join(dir, 'audit.jsonl')
    const good = JSON.stringify({
      kind: 'consent', at: 1, principal: 'alice',
      target: { nodeId: 'n1' }, level: 'view', grants: ['g1'],
    })
    await writeFile(file, `${good}\n{"kind":`, 'utf8')
    const reopened = await VncAuditLog.open(file, 1024, logger())
    expect(reopened.all()).toHaveLength(1)
    expect(reopened.all()[0]!.kind).toBe('consent')
  })
})
