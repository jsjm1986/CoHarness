/** Computer switching retains the current route and protects its unsaved form. */
import { useState, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { usePendingEdits } from './pending-edits.tsx'
import type { RuntimeNodeId } from '../../src/runtime-catalog.ts'

const secondary = '10000000-0000-4000-8000-000000000002' as RuntimeNodeId
vi.mock('./deployment-context.tsx', () => ({
  DeploymentContextProvider: ({ children }: { children: ReactNode }) => children,
  useDeploymentContext: () => ({ value: { scope: 'organization' }, error: false }),
}))
vi.mock('./ComputerSelector.tsx', () => ({
  ComputerSelector: ({ onSelect }: { onSelect(node?: RuntimeNodeId): void }) => <>
    <button onClick={() => onSelect(undefined)}>Center</button>
    <button onClick={() => onSelect(secondary)}>Secondary</button>
  </>,
}))
vi.mock('./pages/UserDetailPage.tsx', () => ({
  UserDetailPage: () => {
    const [value, setValue] = useState('baseline')
    usePendingEdits(value !== 'baseline')
    return <input aria-label="Unsaved quota" value={value} onChange={event => setValue(event.target.value)} />
  },
}))
afterEach(() => { cleanup(); window.history.replaceState({}, '', '/admin/') })

it.each([
  { source: '/admin/users/23', button: 'Secondary', target: `/admin/computers/${secondary}/users/23` },
  { source: `/admin/computers/${secondary}/users/23`, button: 'Center', target: '/admin/users/23' },
])('keeps the exact user route and draft when switching from $source', async ({ source, button, target }) => {
  window.history.replaceState({}, '', `${source}?from=qa#quota`)
  render(<App />)
  const input = await screen.findByRole('textbox', { name: 'Unsaved quota' })
  fireEvent.change(input, { target: { value: '12345' } })
  fireEvent.click(screen.getByRole('button', { name: button }))
  const dialog = screen.getByRole('dialog', { name: '保留当前编辑' })
  expect(within(dialog).getByRole('link', { name: '在新标签页打开' }).getAttribute('href')).toBe(`${target}?from=qa#quota`)
  fireEvent.click(within(dialog).getByRole('button', { name: '留在当前页面' }))
  expect(window.location.pathname).toBe(source)
  expect(screen.getByRole('textbox', { name: 'Unsaved quota' })).toBe(input)
  expect(input).toHaveProperty('value', '12345')
})
