import { describe, expect, it } from 'vitest'
import {
  CENTER_MIN, computeColumns,
  DETAILS_DEFAULT, SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

// Numeric preference form (0 = closed, non-zero = open at the fixed width).
const open = () => 1
const closed = () => 0

describe('computeColumns', () => {
  it('step 1: everything fits at its fixed width', () => {
    const cols = computeColumns(1920, open(), open())
    expect(cols).toEqual({ sidebar: SIDEBAR_DEFAULT, center: 1920 - SIDEBAR_DEFAULT - DETAILS_DEFAULT, details: DETAILS_DEFAULT })
  })

  it('closed sidebar keeps its compact rail while closed details contribute zero width', () => {
    expect(computeColumns(1920, closed(), closed()))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 1920 - SIDEBAR_COLLAPSED, details: 0 })
  })

  it('non-zero preferences open at the contract widths — there is no in-between', () => {
    const cols = computeColumns(1920, open(), open())
    expect(cols.sidebar).toBe(SIDEBAR_DEFAULT)
    expect(cols.details).toBe(DETAILS_DEFAULT)
  })

  it('step 2: details auto-closes when its fixed width starves center — sidebar holds its width', () => {
    // 280 + 360 + 400 = 1040 > 1000 → details 0; sidebar untouched: center = 1000-280 = 720.
    const cols = computeColumns(1000, open(), open())
    expect(cols).toEqual({ sidebar: SIDEBAR_DEFAULT, center: 720, details: 0 })
  })

  it('boundary: exactly at the fit seam details stays open, one px below it closes', () => {
    const seam = SIDEBAR_DEFAULT + DETAILS_DEFAULT + CENTER_MIN
    expect(computeColumns(seam, open(), open()))
      .toEqual({ sidebar: SIDEBAR_DEFAULT, center: CENTER_MIN, details: DETAILS_DEFAULT })
    expect(computeColumns(seam - 1, open(), open()))
      .toEqual({ sidebar: SIDEBAR_DEFAULT, center: seam - 1 - SIDEBAR_DEFAULT, details: 0 })
  })

  it('the sidebar never concedes: center absorbs the deficit below CENTER_MIN', () => {
    // 650 < 280+400: sidebar keeps 280, center takes 370 < CENTER_MIN.
    const cols = computeColumns(650, open(), closed())
    expect(cols).toEqual({ sidebar: SIDEBAR_DEFAULT, center: 370, details: 0 })
  })

  it('sidebar-closed narrow window: details fits at the seam or auto-closes below it', () => {
    const seam = SIDEBAR_COLLAPSED + DETAILS_DEFAULT + CENTER_MIN
    expect(computeColumns(seam, closed(), open()))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: CENTER_MIN, details: DETAILS_DEFAULT })
    expect(computeColumns(seam - 1, closed(), open()))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: seam - 1 - SIDEBAR_COLLAPSED, details: 0 })
  })

  it('tiny viewport: details closes, sidebar holds, center takes the remainder', () => {
    const cols = computeColumns(400, open(), open())
    expect(cols.details).toBe(0)
    expect(cols.sidebar).toBe(SIDEBAR_DEFAULT)
    expect(cols.center).toBe(Math.max(0, 400 - SIDEBAR_DEFAULT))
  })

  it('recovery is pure: re-widening restores the open widths untouched', () => {
    const squeezed = computeColumns(950, open(), open())
    expect(squeezed.details).toBe(0)
    const restored = computeColumns(1920, open(), open())
    expect(restored.details).toBe(DETAILS_DEFAULT)
    expect(restored.sidebar).toBe(SIDEBAR_DEFAULT)
  })
})

describe('computeColumns — degenerate viewports', () => {
  it('sidebar closed and viewport starved: details auto-closes, center takes the rest', () => {
    expect(computeColumns(500, closed(), open()))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 500 - SIDEBAR_COLLAPSED, details: 0 })
  })
})
