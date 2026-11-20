import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { Field } from './ui.tsx'

afterEach(cleanup)

it.each(['input', 'textarea', 'select'] as const)('names a %s with its label and exposes its hint as a description', async (element) => {
  render(<Field label="Project" hint="Choose a unique name.">
    {element === 'input' ? <input /> : element === 'textarea' ? <textarea /> : <select><option>Example</option></select>}
  </Field>)
  const control = screen.getByRole(element === 'select' ? 'combobox' : 'textbox', {
    name: 'Project', description: 'Choose a unique name.',
  })
  await userEvent.click(screen.getByText('Project'))
  expect(document.activeElement).toBe(control)
})

it('retains an explicit control id and adds the hint to its existing description', () => {
  render(<><p id="existing-help">Use your organization name.</p>
    <Field label="Project" hint="Choose a unique name.">
      <input id="project-name" aria-describedby="existing-help" />
    </Field>
  </>)
  const control = screen.getByRole('textbox', {
    name: 'Project', description: 'Use your organization name. Choose a unique name.',
  })
  expect(control.id).toBe('project-name')
  expect(screen.getByLabelText('Project')).toBe(control)
})

it('associates wrapped controls and keeps separate fields distinct', () => {
  render(<>
    <Field label="Search" hint="Search by document name.">{controlProps => <div><input {...controlProps} /></div>}</Field>
    <Field label="Owner"><input /></Field>
  </>)
  const search = screen.getByRole('textbox', { name: 'Search', description: 'Search by document name.' })
  const owner = screen.getByRole('textbox', { name: 'Owner', description: '' })
  expect(screen.getByLabelText('Search')).toBe(search)
  expect(screen.getByLabelText('Owner')).toBe(owner)
  expect(search.id).not.toBe(owner.id)
  expect(owner.hasAttribute('aria-describedby')).toBe(false)
})
