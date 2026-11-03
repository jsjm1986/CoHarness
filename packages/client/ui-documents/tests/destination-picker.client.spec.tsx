// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentDestinationPicker } from '../src/client/DocumentDestinationPicker.tsx'

afterEach(cleanup)
const options = [{ value: '', label: 'Root folder' }, { value: 'a', label: '完整的项目资料与客户需求说明_包含多层目录和移动端验收_2026年10月' }]
const labels = { label: 'Destination folder', searchPlaceholder: 'Search folders', emptyLabel: 'No matching folders', selectedLabel: (name: string) => `Selected: ${name}` }

describe('document destination selection', () => {
  it('keeps the root destination selected when search hides its row', () => {
    const choose = vi.fn()
    render(<DocumentDestinationPicker {...labels} options={options} value="" onChange={choose} searchable />)
    expect(screen.getByRole('radio', { name: 'Root folder' })).toHaveProperty('checked', true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search folders' }), { target: { value: '不存在' } })
    expect(screen.getByRole('status').textContent).toBe('No matching folders')
    expect(screen.getByText('Selected: Root folder')).toBeTruthy()
    expect(choose).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search folders' }), { target: { value: '' } })
    expect(screen.getByRole('radio', { name: 'Root folder' })).toHaveProperty('checked', true)
  })

  it('passes the original directory value and exposes the complete long name', () => {
    const choose = vi.fn()
    render(<DocumentDestinationPicker {...labels} options={options} value="" onChange={choose} />)
    fireEvent.click(screen.getByRole('radio', { name: options[1]!.label }))
    expect(choose).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('keeps a controlled search and disabled destinations under the caller’s ownership', () => {
    const choose = vi.fn()
    const search = vi.fn()
    render(<DocumentDestinationPicker {...labels} options={options} value="a" onChange={choose}
      query="项目" onQueryChange={search} searchable disabled />)
    expect(screen.getByRole('radio', { name: options[1]!.label }).closest('fieldset')?.disabled).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Search folders' })).toHaveProperty('value', '项目')
    expect(choose).not.toHaveBeenCalled()
  })
})
