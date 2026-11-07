// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentSortControl } from '../src/client/DocumentSortControl.tsx'
import { zh, type DocumentsKey } from '../src/client/locales.ts'
import type { DocumentSort } from '../src/client/listing.ts'

const t = (key: DocumentsKey) => zh[key]
function SortFixture({ inline = false }: { inline?: boolean }) {
  const [value, setValue] = useState('date:desc')
  const [key, dir] = value.split(':') as [DocumentSort['key'], DocumentSort['dir']]
  return <><DocumentSortControl sort={{ key, dir }} onChange={setValue} t={t} inline={inline} /><output>{value}</output></>
}

afterEach(cleanup)
describe('document sort presentation', () => {
  it.each([
    ['date', 'desc', '最新在前'], ['date', 'asc', '最早在前'],
    ['name', 'asc', 'A 到 Z'], ['name', 'desc', 'Z 到 A'],
    ['size', 'desc', '最大在前'], ['size', 'asc', '最小在前'],
  ] as const)('preserves the existing %s:%s listing value', (key, dir, label) => {
    render(<SortFixture />)
    fireEvent.click(screen.getByRole('button', { name: t('modal.sort') }))
    fireEvent.click(screen.getByRole('menuitem', { name: t(`sort.field.${key}`) }))
    fireEvent.click(screen.getByRole('button', { name: t('modal.sort') }))
    fireEvent.click(screen.getByRole('menuitem', { name: label }))
    expect(screen.getByRole('status').textContent).toBe(`${key}:${dir}`)
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('provides the same fields and contextual directions as radios in the phone sheet', () => {
    render(<SortFixture inline />)
    expect(screen.getAllByRole('radio')).toHaveLength(5)
    fireEvent.click(screen.getByRole('radio', { name: '名称' }))
    expect(screen.getByRole('status').textContent).toBe('name:asc')
    fireEvent.click(screen.getByRole('radio', { name: 'Z 到 A' }))
    expect(screen.getByRole('status').textContent).toBe('name:desc')
  })
})
