import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Metric } from './usage.tsx'

describe('Metric', () => {
  it('uses the shared metric card class and warning tone', () => {
    render(<Metric label="近 24 小时失败" value="3" tone="warning" />)

    const value = screen.getByText('3')
    const card = value.closest('.metric')
    expect(card).toBeTruthy()
    expect(card?.classList.contains('metric-warning')).toBe(true)
  })
})
