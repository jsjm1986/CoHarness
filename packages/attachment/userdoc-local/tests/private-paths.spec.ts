/** Filesystem metadata can expose private directory aliases that do not share their long spelling. */
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { INVALID_DOCUMENT_REF_CODE } from '@deepseek-ai/dsh-userdoc'
import { assertPublicDirectory, isDocumentPartial, isPrivateRootName, pathForDocId, pathForDirectoryId } from '../src/name.ts'

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  return { ...actual, lstat: vi.fn(actual.lstat) }
})
const actual = await vi.importActual<typeof fs>('node:fs/promises')
beforeEach(() => { vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat) })

it.each(['.upload-sessions', '.dsh-trash'])('refuses another spelling of the actual private directory object: %s', async (name) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-private-directory-alias-'))
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }))
  const hidden = join(root, name), alias = join(root, 'SHORT')
  await fs.mkdir(hidden); await fs.mkdir(alias)
  // The public filesystem parser receives the same object identity for a short/long-name alias.
  vi.mocked(fs.lstat).mockImplementation((path, options) => actual.lstat(path === alias ? hidden : path, options))
  await expect(assertPublicDirectory(root, alias, INVALID_DOCUMENT_REF_CODE)).rejects.toMatchObject({ code: INVALID_DOCUMENT_REF_CODE })
})

it.each(['.UPLOAD-SESSIONS', '.upload-ſeſſions', '.DSH-TRASH.', '.dsh-traſh '])('reserves maintenance spelling %s', (name) => {
  expect(isPrivateRootName(name)).toBe(true)
  expect(() => pathForDocId('/documents', `${name}/file.txt`)).toThrow()
  expect(() => pathForDirectoryId('/documents', name)).toThrow()
})

it('reserves only actual staging leaves while allowing ordinary part filenames', () => {
  const root = resolve('/documents')
  expect(isDocumentPartial(`.USERDOC-${'A'.repeat(24)}.PART.`)).toBe(true)
  for (const name of ['archive.part', 'file.userdoc.part', `.userdoc-${'a'.repeat(23)}.part`, '.part']) {
    expect(isDocumentPartial(name)).toBe(false)
    expect(pathForDocId(root, name)).toBe(join(root, name))
  }
})
