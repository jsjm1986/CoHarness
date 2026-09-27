// @vitest-environment jsdom
/** HTML dependency URLs resolve inside the source file's Session through the same authorized service. */
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceResourceError, workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import { createReadHtmlRelative, normalizeWorkspacePath } from '../src/client/html/read-relative.ts'
import type { ReadWorkspaceFileData } from '../src/client/html/read-relative.ts'

const sessionId = 'html-session' as SessionId
const request: WorkspaceResourceOpenRequest = {
  runtimeTarget: { kind: 'project', projectId: 3 }, sessionId, path: 'sub/index.html',
  address: workspaceResourceAddress(sessionId, 'sub/index.html'),
}
const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)

describe('normalizeWorkspacePath', () => {
  it.each([
    ['a/b.js', 'a/b.js'], ['./a/b.js', 'a/b.js'], ['a/./b.js', 'a/b.js'],
    ['a/sub/../b.js', 'a/b.js'], ['a//b.js', 'a/b.js'],
  ])('folds %s into %s', (input, expected) => {
    expect(normalizeWorkspacePath(input)).toBe(expected)
  })

  it.each([['..'], ['../x.js'], ['a/../../x.js'], ['.'], [''], ['a/../..']])(
    'rejects %s escaping the workspace root', (input) => {
      expect(normalizeWorkspacePath(input)).toBeUndefined()
    },
  )
})

describe('createReadHtmlRelative', () => {
  it('decodes a relative URL once and reads the sibling resource on the same runtime and Session', async () => {
    const read = vi.fn<ReadWorkspaceFileData>().mockResolvedValue({ data: utf8('x'), version: 'v7' })
    const lifetime = new AbortController()
    const loading = new AbortController()
    const readRelative = createReadHtmlRelative(read, request, lifetime.signal)
    await expect(readRelative('../a%20b.js?v=1#fragment', loading.signal)).resolves.toEqual(utf8('x'))
    const call = read.mock.calls[0]!
    expect(call[0]).toEqual({
      resource: {
        runtimeTarget: request.runtimeTarget,
        sessionId,
        path: 'a b.js',
        address: workspaceResourceAddress(sessionId, 'a b.js'),
      },
    })
    const signal = call[1]
    expect(signal.aborted).toBe(false)
    lifetime.abort()
    expect(signal.aborted).toBe(true)
  })

  it('refuses non-relative references and paths escaping the workspace without a read', async () => {
    const read = vi.fn<ReadWorkspaceFileData>()
    const signal = new AbortController().signal
    const readRelative = createReadHtmlRelative(read, request, signal)
    for (const path of ['', '/x.js', 'file:///x.js', '%2Fx.js', 'C:/x.js', '..\\x.js', '%00.js', '%ZZ.js', '../../outside.js']) {
      await expect(readRelative(path, signal)).rejects.toThrow()
    }
    expect(read).not.toHaveBeenCalled()
    read.mockRejectedValueOnce(new WorkspaceResourceError('workspace-file/outside-workspace', 'outside workspace'))
    await expect(readRelative('nested/../x.js', signal)).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
  })

  it('does not start an already cancelled read', async () => {
    const controller = new AbortController()
    controller.abort()
    const read = vi.fn<ReadWorkspaceFileData>()
    const readRelative = createReadHtmlRelative(read, request, controller.signal)
    await expect(readRelative('x.js', new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects bytes that arrive after this packing request is cancelled', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<ReadWorkspaceFileData>>>()
    const read = vi.fn<ReadWorkspaceFileData>().mockReturnValue(pending.promise)
    const loading = new AbortController()
    const readRelative = createReadHtmlRelative(read, request, new AbortController().signal)
    const result = readRelative('./late.js', loading.signal)
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    loading.abort()
    pending.resolve({ data: utf8('late'), version: 'v1' })
    await rejected
  })
})
