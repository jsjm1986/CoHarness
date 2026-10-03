import { describe, expect, it } from 'vitest'
import {
  CENTER_MIN, clampWidth, computeColumns,
  DETAILS_MAX_RATIO, DETAILS_MIN, SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

// Numeric preference form (0 = closed); helpers keep the scenario names readable.
const open = (width: number) => width
const closed = (_width: number) => 0

describe('clampWidth', () => {
  it('clamps into the range and rounds', () => {
    expect(clampWidth(250.4, 240, 420)).toBe(250)
    expect(clampWidth(100, 240, 420)).toBe(240)
    expect(clampWidth(9999, 240, 420)).toBe(420)
  })
})

describe('computeColumns', () => {
  it('step 1: everything fits at preferred widths', () => {
    const cols = computeColumns(1920, open(SIDEBAR_DEFAULT), open(864))
    expect(cols).toEqual({ sidebar: 280, center: 1920 - 280 - 864, details: 864 })
  })

  it('closed sidebar keeps its compact rail while closed details contribute zero width', () => {
    expect(computeColumns(1920, closed(300), closed(360)))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 1920 - SIDEBAR_COLLAPSED, details: 0 })
  })

  it('preferences beyond the clamp range are clamped before solving', () => {
    const cols = computeColumns(1920, open(9999), open(1))
    expect(cols.sidebar).toBe(420)
    expect(cols.details).toBe(300)
    expect(computeColumns(1920, open(1), open(360)).sidebar).toBe(SIDEBAR_MIN)
  })

  it('details caps at the viewport ratio ceiling', () => {
    // ceil(3000 * 0.7) = 2100 < available 2320: the ratio ceiling binds.
    const cap = Math.ceil(3000 * DETAILS_MAX_RATIO)
    const cols = computeColumns(3000, open(SIDEBAR_DEFAULT), open(9999))
    expect(cols).toEqual({ sidebar: 280, center: 3000 - 280 - cap, details: cap })
    // The stored pixel preference under the ceiling passes through.
    expect(computeColumns(1920, open(SIDEBAR_DEFAULT), open(1100)).details).toBe(1100)
    // And beyond it.
    expect(computeColumns(1920, open(SIDEBAR_DEFAULT), open(2000)).details).toBe(1240)
  })

  it('step 2: details shrinks first, center pinned at min', () => {
    // 280 + 360 + 400 = 1040 > 1039; details concedes to 1039-280-400 = 359.
    const cols = computeColumns(1039, open(SIDEBAR_DEFAULT), open(360))
    expect(cols).toEqual({ sidebar: 280, center: CENTER_MIN, details: 359 })
  })

  it('boundary: exactly at the step-1/step-2 seam', () => {
    const cols = computeColumns(300 + 360 + CENTER_MIN, open(300), open(360))
    expect(cols).toEqual({ sidebar: 300, center: CENTER_MIN, details: 360 })
    const one = computeColumns(300 + 360 + CENTER_MIN - 1, open(300), open(360))
    expect(one).toEqual({ sidebar: 300, center: CENTER_MIN, details: 359 })
  })

  it('step 3: details auto-closes when its min still starves center — sidebar holds its preference', () => {
    // 280 + 300 + 400 = 980 > 979 → details 0; sidebar untouched: center = 979-280 = 699.
    const cols = computeColumns(979, open(SIDEBAR_DEFAULT), open(360))
    expect(cols).toEqual({ sidebar: 280, center: 699, details: 0 })
  })

  it('the sidebar never concedes: center absorbs the deficit below CENTER_MIN', () => {
    // 700 < 280+400: sidebar keeps 280, center takes 420 > CENTER_MIN anyway;
    // drop further and the rail-floored center just absorbs it.
    const cols = computeColumns(700, open(SIDEBAR_DEFAULT), closed(360))
    expect(cols).toEqual({ sidebar: SIDEBAR_DEFAULT, center: 420, details: 0 })
  })

  it('sidebar-closed narrow window: details concedes then auto-closes', () => {
    const fits = computeColumns(SIDEBAR_COLLAPSED + DETAILS_MIN + CENTER_MIN, closed(300), open(360))
    expect(fits).toEqual({ sidebar: SIDEBAR_COLLAPSED, center: CENTER_MIN, details: DETAILS_MIN })
    const starved = computeColumns(SIDEBAR_COLLAPSED + DETAILS_MIN + CENTER_MIN - 1, closed(300), open(360))
    expect(starved).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: DETAILS_MIN + CENTER_MIN - 1,
      details: 0,
    })
  })

  it('tiny viewport: details closes, sidebar holds, center takes the remainder', () => {
    const cols = computeColumns(400, open(SIDEBAR_DEFAULT), open(360))
    expect(cols.details).toBe(0)
    expect(cols.sidebar).toBe(SIDEBAR_DEFAULT)
    expect(cols.center).toBe(Math.max(0, 400 - SIDEBAR_DEFAULT))
  })

  it('recovery is pure: re-widening restores preferred widths untouched', () => {
    const squeezed = computeColumns(900, open(SIDEBAR_DEFAULT), open(360))
    expect(squeezed.details).toBe(0)
    const restored = computeColumns(1920, open(SIDEBAR_DEFAULT), open(864))
    expect(restored.details).toBe(864)
    expect(restored.sidebar).toBe(SIDEBAR_DEFAULT)
  })
})

describe('computeColumns — degenerate viewports', () => {
  it('sidebar closed and viewport below CENTER_MIN: details auto-closes, center takes the rest', () => {
    // Reaches the auto-close fallback with the compact rail sidebar.
    expect(computeColumns(500, closed(300), open(360)))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 500 - SIDEBAR_COLLAPSED, details: 0 })
  })
})
