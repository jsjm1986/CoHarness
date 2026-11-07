/** Actual wire JSON must not add actors, roots or unadvertised operations. */
import { expect, it } from 'vitest'
import { USERDOC_ERROR_CODES, userDocErrorStatus } from '@deepseek-ai/dsh-userdoc'
import { documentFailureSchema, documentRequestSchema, documentResultSchemas } from '../src/protocol.ts'

const authority = { kind: 'execution', sessionId: 'session-owner', scopeId: 'scope-owner' }

it.each([
  { kind: 'describe' },
  { kind: 'resolveTarget', input: { name: '文档.txt', directoryId: '' } },
  { kind: 'save', target: { docId: '文档.txt', name: '文档.txt', path: '/documents/文档.txt' } },
  { kind: 'beginUpload', input: { name: 'a.txt', directoryId: '', bytes: 1, fingerprint: 'file' } },
  { kind: 'inspectUpload', uploadId: 'upload', ownerId: 'user:7' },
  { kind: 'writeUploadChunk', uploadId: 'upload', chunk: { index: 0, start: 0, end: 0, total: 1, sha256: '0'.repeat(64) } },
  { kind: 'completeUpload', uploadId: 'upload', sha256: '0'.repeat(64) },
  { kind: 'cancelUpload', uploadId: 'upload' },
  { kind: 'list' }, { kind: 'listDirectory', directoryId: '' }, { kind: 'listTrash' },
  { kind: 'listDirectoryPage', directoryId: '', query: { limit: 1, sort: 'name-asc', state: 'active' } },
  { kind: 'listTrashPage', query: { limit: 100, sort: 'name-desc', state: 'trash' } },
  { kind: 'trash', docId: 'a.txt' }, { kind: 'restore', docId: 'a.txt', directoryId: '', name: 'restored.txt' },
  { kind: 'purge', docId: 'a.txt' }, { kind: 'listDirectories' },
  { kind: 'createDirectory', parentDirectoryId: '', name: 'folder' },
  { kind: 'renameDirectory', directoryId: 'folder', name: 'renamed' },
  { kind: 'removeDirectory', directoryId: 'folder' }, { kind: 'move', docId: 'a.txt', directoryId: 'folder' },
  { kind: 'stat', docId: 'a.txt' }, { kind: 'openRead', docId: 'a.txt' }, { kind: 'remove', docId: 'a.txt' },
])('accepts the declared $kind operation without changing its identity or arguments', (operation) => {
  const input = { version: 1, authority, operation }
  expect(documentRequestSchema.parse(JSON.parse(JSON.stringify(input)))).toEqual(input)
})

it.each([
  { kind: 'readSomeoneElse', ownerId: 8 },
  { kind: 'stat', docId: 'a.txt', ownerId: 'user:8' },
  { kind: 'list', root: '/another-account' },
  { kind: 'beginUpload', input: { name: 'a.txt', directoryId: '', bytes: -1, fingerprint: 'file' } },
  { kind: 'writeUploadChunk', uploadId: 'upload', chunk: { index: 0, start: 0, end: 0, total: 1, sha256: 'bad' } },
])('refuses unadvertised fields and malformed raw operation arguments', (operation) => {
  expect(documentRequestSchema.safeParse({ version: 1, authority, operation }).success).toBe(false)
})

it('does not let request metadata select a different actor or runtime', () => {
  for (const invalid of [
    { ...authority, userId: 8 }, { ...authority, runtime: { kind: 'user', id: 8 } }, { kind: 'request', scopeId: 'scope-owner' },
  ]) {
    expect(documentRequestSchema.safeParse({ version: 1, authority: invalid, operation: { kind: 'list' } }).success).toBe(false)
  }
})

it('omits optional undefined values at the wire parser before passing arguments to the implementation', () => {
  const parsed = documentRequestSchema.parse({ version: 1, authority, operation: {
    kind: 'restore', docId: 'a.txt', directoryId: undefined, name: undefined,
  } })
  expect(parsed.operation).toEqual({ kind: 'restore', docId: 'a.txt' })
  expect(Object.hasOwn(parsed.operation, 'directoryId')).toBe(false)
  expect(Object.hasOwn(parsed.operation, 'name')).toBe(false)
})

it.each(['trash', 'move', 'remove'] as const)('preserves an exact active selection and rejects another path for %s', (kind) => {
  const expected = { docId: 'a.txt', incarnationId: 'incarnation-a', revision: 2 }
  const operation = { kind, docId: 'a.txt', ...(kind === 'move' ? { directoryId: 'folder' } : {}), expected }
  expect(documentRequestSchema.parse({ version: 1, authority, operation }).operation).toEqual(operation)
  for (const invalid of [{ ...expected, docId: 'other.txt' }, { ...expected, revision: 0 }]) {
    expect(documentRequestSchema.safeParse({ version: 1, authority, operation: { ...operation, expected: invalid } }).success).toBe(false)
  }
})

it.each(['restore', 'purge'] as const)('preserves the exact trash action and refuses conflicting selectors for %s', (kind) => {
  const expected = { docId: 'a.txt', incarnationId: 'incarnation-a', revision: 2, trashId: 'trash-a' }
  const operation = { kind, docId: 'a.txt', expected }
  for (const valid of [operation, { ...operation, trashId: expected.trashId }]) {
    expect(documentRequestSchema.parse({ version: 1, authority, operation: valid }).operation).toEqual(valid)
  }
  for (const invalid of [{ ...operation, trashId: 'another-trash' }, { ...operation, expected: { ...expected, docId: 'other.txt' } }]) {
    expect(documentRequestSchema.safeParse({ version: 1, authority, operation: invalid }).success).toBe(false)
  }
})

it('preserves the authorized directory inventory in the rename envelope', () => {
  const operation = { kind: 'renameDirectory', directoryId: 'folder', name: 'renamed',
    expected: [{ docId: 'folder/a.txt', incarnationId: 'incarnation-a', revision: 2 }] }
  expect(documentRequestSchema.parse({ version: 1, authority, operation }).operation).toEqual(operation)
})

it('retains valid pre-epoch file modification times', () => {
  const ref = { docId: 'old.txt', name: 'old.txt', path: '/documents/old.txt', bytes: 1, mediaType: 'text/plain', modifiedAt: -1000 }
  expect(documentResultSchemas.stat.parse(ref)).toEqual(ref)
})

it('preserves every stable domain failure and rejects unknown remote codes', () => {
  for (const code of USERDOC_ERROR_CODES) {
    expect(documentFailureSchema.parse({ version: 1, kind: 'error', error: { code, message: 'Document request failed.' } }).error.code).toBe(code)
  }
  expect(documentFailureSchema.safeParse({ version: 1, kind: 'error', error: { code: 'UNADVERTISED', message: 'Failure' } }).success).toBe(false)
  expect(userDocErrorStatus('DOCUMENT_PERMISSION_DENIED')).toBe(403)
  expect(userDocErrorStatus('DOCUMENT_STORE_BUSY')).toBe(429)
  expect(userDocErrorStatus('DOCUMENT_TRANSPORT_PROTOCOL')).toBe(400)
})
