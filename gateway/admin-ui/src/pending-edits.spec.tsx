/** Existing quota drafts survive navigation attempts without browser-shared draft storage. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeAllocationPolicyEditor } from './components/RuntimeAllocationPolicyEditor.tsx'
import { PendingEditsProvider, useProtectedNavigation } from './pending-edits.tsx'
import * as api from './api.ts'

vi.mock('./api.ts', () => ({ getRuntimeAllocationPolicy: vi.fn(), saveRuntimeAllocationPolicy: vi.fn() }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function Destination() {
  const navigation = useProtectedNavigation()
  return <button onClick={() => navigation.navigate('/admin/computers/10000000-0000-4000-8000-000000000002/users/2')}>Computer B</button>
}

it('keeps the original quota form mounted, offers the exact target in a new tab, and clears protection on restoring the baseline', async () => {
  vi.mocked(api.getRuntimeAllocationPolicy).mockResolvedValue({ revision: '0', maxTotal: 8, maxPerNode: 4, source: 'organization' })
  render(<PendingEditsProvider><RuntimeAllocationPolicyEditor userId={2} /><Destination /></PendingEditsProvider>)
  const input = await screen.findByRole('spinbutton', { name: '总配额' })
  fireEvent.change(input, { target: { value: '9' } })
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Computer B' }))
  const dialog = screen.getByRole('dialog', { name: '保留当前编辑' })
  expect(within(dialog).getByRole('link', { name: '在新标签页打开' }).getAttribute('href')).toBe('/admin/computers/10000000-0000-4000-8000-000000000002/users/2')
  expect(within(dialog).getByRole('link').getAttribute('target')).toBe('_blank')
  fireEvent.click(within(dialog).getByRole('button', { name: '留在当前页面' }))
  expect(screen.getByRole('spinbutton', { name: '总配额' })).toBe(input)
  expect(input).toHaveProperty('value', '9')
  expect(api.saveRuntimeAllocationPolicy).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '8' } })
  const clean = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(clean)
  expect(clean.defaultPrevented).toBe(false)
})

it('protects existing Admin navigation links and unregisters its unload handler on disposal', async () => {
  vi.mocked(api.getRuntimeAllocationPolicy).mockResolvedValue({ revision: '0', maxTotal: 8, maxPerNode: 4, source: 'organization' })
  const view = render(<PendingEditsProvider><RuntimeAllocationPolicyEditor /><a href="/admin/models">Models</a></PendingEditsProvider>)
  fireEvent.change(await screen.findByRole('spinbutton', { name: '总配额' }), { target: { value: '9' } })
  fireEvent.click(screen.getByRole('link', { name: 'Models' }))
  expect(screen.getByRole('dialog', { name: '保留当前编辑' })).toBeTruthy()
  view.unmount()
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(false)
})

it('keeps the same form and draft when browser history requests the previous Admin route', async () => {
  vi.mocked(api.getRuntimeAllocationPolicy).mockResolvedValue({ revision: '0', maxTotal: 8, maxPerNode: 4, source: 'organization' })
  const router = createMemoryRouter([{ path: '*', element: <PendingEditsProvider protectHistory>
    <RuntimeAllocationPolicyEditor userId={2} />
  </PendingEditsProvider> }], { basename: '/admin', initialEntries: ['/admin/models', '/admin/users/2'], initialIndex: 1 })
  const view = render(<RouterProvider router={router} />)
  try {
    const input = await screen.findByRole('spinbutton', { name: '总配额' })
    fireEvent.change(input, { target: { value: '9' } })
    await act(async () => { await router.navigate(-1) })
    const dialog = await screen.findByRole('dialog', { name: '保留当前编辑' })
    expect(within(dialog).getByRole('link', { name: '在新标签页打开' }).getAttribute('href')).toBe('/admin/models')
    expect(router.state.location.pathname).toBe('/admin/users/2')
    fireEvent.click(within(dialog).getByRole('button', { name: '留在当前页面' }))
    expect(screen.getByRole('spinbutton', { name: '总配额' })).toBe(input)
    expect(input).toHaveProperty('value', '9')
  } finally { view.unmount(); router.dispose() }
})
