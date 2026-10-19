/** Host Loader entry stays inert; all registrations live in the client half. */
import { describe, expect, it } from 'vitest'
import { apply as hostApply } from '../src/index.ts'

describe('ui-sidebar-browser host entry', () => {
  it('keeps the Host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })
})
