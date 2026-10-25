// @vitest-environment jsdom
/** Resource-local recovery preserves the loaded body, effective failure and retry action. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { previewRecoveryLabels } from './workspace-preview-resource.fixture.tsx'
import { workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { WorkspacePreviewChrome } from '../src/client/components/WorkspacePreviewChrome.tsx'
import type { WorkspacePreviewChromeState } from '../src/client/components/WorkspacePreviewChrome.tsx'
import type { WorkspacePreviewResource } from '../src/client/contract/preview/use-preview-read.ts'

afterEach(cleanup)
const sessionId = 'preview-recovery' as SessionId
const request = { sessionId, path: 'data.csv', runtimeTarget: { kind: 'base' as const }, address: workspaceResourceAddress(sessionId, 'data.csv') }
const labels = { close: 'Close', reload: 'Reload', reconnecting: 'Reload · reconnecting', ...previewRecoveryLabels, changed: 'File changed', loading: 'Loading' }
const failure = { code: 'connection-unavailable', message: 'Workspace connection is reconnecting' }
const value = { sessionId, path: request.path, type: 'file' as const, version: 'v1', changed: false }

function preview(options: { hasContent: boolean; denied?: boolean; error?: Error; code?: string }) {
  const reload = vi.fn(async () => true)
  const close = vi.fn()
  const state: WorkspacePreviewChromeState = {
    pending: false, reloading: false, changed: false, denied: options.denied === true, error: options.error,
    reload: async () => { await reload() },
  }
  const resource: WorkspacePreviewResource = {
    metadata: { status: 'failed', value, accessDenied: state.denied, error: { ...failure, code: options.code ?? failure.code } },
    reload, revoke: vi.fn(),
  }
  return { reload, close, state, resource, element: <WorkspacePreviewChrome request={request} resource={resource} state={state}
    className={undefined} message={options.error?.message ?? failure.message} hasContent={options.hasContent} close={close} labels={labels}>
    {options.hasContent && !state.denied && <div>Loaded cells</div>}
  </WorkspacePreviewChrome> }
}

it('announces the full connection failure beside the existing resource reload action and retains focus', () => {
  const h = preview({ hasContent: true })
  const healthy: WorkspacePreviewResource = { ...h.resource, metadata: { status: 'live', value, accessDenied: false } }
  const view = render(<WorkspacePreviewChrome request={request} resource={healthy} state={h.state} className={undefined}
    message={undefined} hasContent close={h.close} labels={labels}><div>Loaded cells</div></WorkspacePreviewChrome>)
  const button = view.getByRole('button', { name: 'Reload' })
  const body = view.getByText('Loaded cells')
  button.focus()
  view.rerender(h.element)
  expect(view.getByRole('button', { name: 'Reload' })).toBe(button)
  expect(document.activeElement).toBe(button)
  expect(view.getByText('Loaded cells')).toBe(body)
  expect(button.getAttribute('data-workspace-preview-reconnecting')).toBe('true')
  const alert = view.getByRole('alert')
  expect(alert.textContent).toBe(failure.message)
  expect(button.getAttribute('aria-describedby')).toBe(alert.id)
  fireEvent.click(button)
  expect(h.reload).toHaveBeenCalledOnce()
  fireEvent.click(view.getByRole('button', { name: 'Close' }))
  expect(h.close).toHaveBeenCalledOnce()
})

it('reports an HTTP request failure beside retained content without claiming automatic stream recovery', () => {
  const h = preview({ hasContent: true, code: 'request-unavailable' })
  const view = render(h.element)
  const button = view.getByRole('button', { name: 'Reload' })
  expect(view.getByText('Loaded cells')).toBeTruthy()
  expect(view.getByRole('alert').textContent).toBe(labels.requestFailedRetained)
  expect(button.getAttribute('data-workspace-preview-request-failed')).toBe('true')
  expect(button.hasAttribute('data-workspace-preview-reconnecting')).toBe(false)
  expect(button.textContent).toContain(labels.reloadFailed)
  expect(button.getAttribute('aria-describedby')).toBe(view.getByRole('alert').id)
  expect(h.reload).not.toHaveBeenCalled()
})

it.each([
  { name: 'an empty preview', hasContent: false },
  { name: 'revoked access', hasContent: true, denied: true },
  { name: 'an unknown metadata failure', hasContent: true, code: 'unknown-failure' },
  { name: 'a content-read failure preceding the metadata outage', hasContent: true, error: new Error('Content read failed') },
])('keeps the full in-place failure for $name', (options) => {
  const h = preview(options)
  const view = render(h.element)
  const button = view.getByRole('button', { name: 'Reload' })
  expect(button.hasAttribute('data-workspace-preview-reconnecting')).toBe(false)
  expect(button.hasAttribute('aria-describedby')).toBe(false)
  expect(view.getByRole('alert').textContent).toBe(options.error?.message ?? failure.message)
  expect(button.hasAttribute('disabled')).toBe(options.denied === true)
})
