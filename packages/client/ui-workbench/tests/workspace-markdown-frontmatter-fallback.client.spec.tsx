// @vitest-environment jsdom
/** A field-list chunk that fails to load leaves the verbatim frontmatter and the Markdown body visible. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { WorkspaceResourceRegistry, workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { WorkspaceMarkdownPreview } from '../src/client/components/WorkspaceMarkdownPreview.tsx'
import type { ReadWorkspacePreview } from '../src/client/components/WorkspaceFilePreview.tsx'
import { en } from '../src/client/markdown/locales.ts'
import { PreviewResourceBinding } from './workspace-preview-resource.fixture.tsx'

vi.mock('../src/client/markdown/frontmatter-fields.tsx', () => {
  throw new Error('chunk unavailable')
})

afterEach(cleanup)

const id = 'markdown-session' as SessionId
const request: WorkspaceResourceOpenRequest = {
  sessionId: id, runtimeTarget: { kind: 'base' }, path: 'notes.md', address: workspaceResourceAddress(id, 'notes.md'),
}

describe('WorkspaceMarkdownPreview frontmatter chunk failure', () => {
  it('keeps the verbatim frontmatter and the body', async () => {
    const text = '---\nname: pdf\n---\n# Body'
    const resources = new WorkspaceResourceRegistry()
    resources.register(request.runtimeTarget, {
      stat: async () => ({ sessionId: id, path: request.path, type: 'file', version: 'v1', bytes: 10, changed: false }),
    }, 5)
    const read = vi.fn<ReadWorkspacePreview>(async () => ({ path: request.path, offset: 1, limit: 5, text, eof: true, version: 'v1' }))
    const view = render(<PreviewResourceBinding resources={resources} request={request}>{resource =>
      <WorkspaceMarkdownPreview request={request} resource={resource} read={read}
        markdownT={makeTranslate(en)} close={() => {}}
        labels={{ close: 'Close', reload: 'Reload', loading: 'Reading', changed: 'File changed' }} />
    }</PreviewResourceBinding>)
    await vi.waitFor(() => { expect(view.container.querySelector('[data-workspace-frontmatter] pre')?.textContent).toBe('name: pdf') })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(view.container.querySelector('[data-workspace-frontmatter] pre')?.textContent).toBe('name: pdf')
    await waitFor(() => { expect(view.getByRole('heading', { name: 'Body' })).toBeTruthy() })
  })
})
