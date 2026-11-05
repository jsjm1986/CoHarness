import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PeerPersonalExporter } from '../src/peer-backup-personal.ts'
import type { Queryable } from '../src/postgres/database.ts'
import { verifyPeerManagedFiles } from '../src/peer-backup-restic.ts'

it.each([1, 2, 3])('projects scoped personal WAL data and draft recovery for source schema %d', async (version) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'peer-personal-')))
  const binding = {
    organizationId: randomUUID(),
    sourceNodeId: randomUUID(),
    targetNodeId: randomUUID(),
    scopeId: randomUUID(),
    policyId: randomUUID(),
    revision: 1,
  }
  const owner = 412
  const control = { query: async () => ({ rows: [{ public_id: String(owner) }], rowCount: 1 }) } as unknown as Queryable
  const output = join(root, 'payload')
  const exporter = new PeerPersonalExporter(control, root, { maxBytes: 4 << 20, maxRows: 100, reserveBytes: 1 << 20 })
  await mkdir(join(root, 'personal-directory'))
  await mkdir(join(root, 'node-content-drafts'))
  await mkdir(output)
  const source = new DatabaseSync(join(root, 'personal-directory', 'index.sqlite'))
  const drafts = new DatabaseSync(join(root, 'node-content-drafts', 'drafts.sqlite'))
  try {
    source.exec(`PRAGMA user_version=1; PRAGMA journal_mode=WAL;
      CREATE TABLE publications(owner TEXT PRIMARY KEY,generation INTEGER,revision INTEGER,digest TEXT,has_conversations INTEGER);
      CREATE TABLE workspaces(owner TEXT,id TEXT,value TEXT); CREATE TABLE members(owner TEXT,workspace TEXT,session TEXT);
      CREATE TABLE conversations(owner TEXT,id TEXT,value TEXT)`)
    drafts.exec(
      `PRAGMA user_version=${version}; PRAGMA journal_mode=WAL; CREATE TABLE drafts(identity TEXT PRIMARY KEY,revision INTEGER,text TEXT${version === 3 ? ',previous_versions TEXT' : ''}) WITHOUT ROWID`,
    )
    for (const [account, runtime, secret] of [
      [owner, binding.scopeId, 'approved'],
      [owner + 1, binding.scopeId, 'foreign-user'],
      [owner, randomUUID(), 'foreign-runtime'],
    ] as const) {
      const key = JSON.stringify([binding.organizationId, binding.sourceNodeId, runtime, account])
      source.prepare('INSERT INTO publications VALUES(?,2,4,?,1)').run(key, 'synthetic digest')
      source.prepare('INSERT INTO conversations VALUES(?,?,?)').run(key, 'same-session', secret)
      for (const tab of ['tab-a', 'tab-b']) {
        const identity = JSON.stringify([
          binding.organizationId,
          binding.sourceNodeId,
          account,
          runtime,
          'local',
          'same-session',
          tab,
        ])
        if (version === 3) drafts.prepare('INSERT INTO drafts VALUES(?,2,?,?)').run(identity, secret + '-' + tab,
          JSON.stringify([{ revision: 1, text: secret + '-earlier' }]))
        else drafts.prepare('INSERT INTO drafts VALUES(?,1,?)').run(identity, secret + '-' + tab)
      }
    }
    const capture = await exporter.capture(binding, output, new AbortController().signal)
    expect(capture).toMatchObject({ writerEpoch: '2', watermark: '4', coveredCount: 2 })
    expect(capture.gaps).toContain('database:independent-domain-watermarks')
    await exporter.validate(binding, capture, output, new AbortController().signal)
    const bytes = await readFile(join(output, 'personal.sqlite'))
    expect(bytes.includes('approved-tab-a')).toBe(true)
    expect(bytes.includes('approved-tab-b')).toBe(true)
    expect(bytes.includes('approved-earlier')).toBe(version === 3)
    expect(bytes.includes('foreign-user')).toBe(false)
    expect(bytes.includes('foreign-runtime')).toBe(false)
  } finally {
    source.close()
    drafts.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('checks Windows managed membership and stored bytes on an isolated recovery host', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'peer-portable-')))
  const path = 'C:\\synthetic\\space',
    info = { mode: 448, uid: 0, gid: 0 }
  try {
    const snapshot = {
      version: 1,
      roots: [{ owner: 'plugin', kind: 'directory', path }],
      directories: [{ ...info, path }],
      absent: [],
      files: [
        {
          ...info,
          member: '00000000.data',
          sourcePath: path + '\\empty',
          sizeBytes: 0,
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
      ],
    }
    await writeFile(join(root, '00000000.data'), '')
    const manifest = join(root, 'manifest.json')
    await writeFile(manifest, JSON.stringify({ platform: 'win32', snapshot }))
    await verifyPeerManagedFiles(root, new AbortController().signal)
    snapshot.files[0]!.sourcePath = 'C:\\another-account\\empty'
    await writeFile(manifest, JSON.stringify({ platform: 'win32', snapshot }))
    await expect(verifyPeerManagedFiles(root, new AbortController().signal)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
