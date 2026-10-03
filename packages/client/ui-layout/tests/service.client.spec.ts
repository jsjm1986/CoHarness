/**
 * LayoutController behavior: the cross-plugin panel-action face. Geometry
 * lives in the entry store (layout-store.spec.ts) — here we assert the
 * delegation contract: the constructor-bound panel actions forward, the
 * auxiliary-panel owner round-trips, and separately constructed controllers
 * keep their own instances.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import type { PanelActions, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'

function fakePanels(): PanelActions {
  return {
    setSidebar: vi.fn(),
    focusRightbar: vi.fn(), openRightbar: vi.fn(), closeRightbar: vi.fn(),
    setDetails: vi.fn(),
    toggleSidebar: vi.fn(),
    setViewportWidth: vi.fn(),
    collapseNarrow: vi.fn(),
    selectPanel: vi.fn(), retainMainPanels: vi.fn(),
  }
}

function fakePanelInfo() {
  return createSnapshotStore<PanelInfo>({ activePanelId: null })
}

describe('LayoutController', () => {
  it('forwards the panel actions to the constructor-bound set', () => {
    const panels = fakePanels()
    const service = new LayoutController(panels, createSnapshotStore(1440), () => true, fakePanelInfo())

    const owner = { openDetails: vi.fn(), close: vi.fn() }
    service.bindRightbar(owner)
    service.toggleSidebar()
    service.openDetails()
    service.closeDetails()

    expect(panels.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(owner.openDetails).toHaveBeenCalledTimes(1)
    expect(owner.close).toHaveBeenCalledTimes(1)
  })

  it('exposes the shared store width through its viewportWidth observable', () => {
    const viewportWidth = createSnapshotStore(0)
    const service = new LayoutController(fakePanels(), viewportWidth, () => true, fakePanelInfo())
    const seen: number[] = []
    const unsubscribe = service.viewportWidth.subscribe(() => { seen.push(service.viewportWidth.getSnapshot()) })
    try {
      viewportWidth.set(700)
      expect(service.viewportWidth.getSnapshot()).toBe(700)
      expect(seen).toEqual([700])
    } finally { unsubscribe() }
  })

  it('can toggle the sidebar immediately after construction', () => {
    const panels = fakePanels()
    const service = new LayoutController(panels, createSnapshotStore(1440), () => true, fakePanelInfo())

    service.toggleSidebar()

    expect(panels.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(panels.setSidebar).not.toHaveBeenCalled()
  })

  it('keeps separately constructed controllers bound to their own instances', () => {
    const first = fakePanels()
    const second = fakePanels()
    const firstService = new LayoutController(first, createSnapshotStore(1440), () => true, fakePanelInfo())
    const secondService = new LayoutController(second, createSnapshotStore(1440), () => true, fakePanelInfo())
    firstService.toggleSidebar()
    expect(first.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(second.toggleSidebar).not.toHaveBeenCalled()
    secondService.closeRightbar()
    expect(first.closeRightbar).not.toHaveBeenCalled()
    expect(second.closeRightbar).toHaveBeenCalledTimes(1)
  })

  it('throws when no auxiliary-panel owner is bound', () => {
    const service = new LayoutController(fakePanels(), createSnapshotStore(1440), () => true, fakePanelInfo())
    expect(() => { service.openDetails() }).toThrow(/auxiliary panel owner is unavailable/)
    expect(() => { service.closeDetails() }).toThrow(/auxiliary panel owner is unavailable/)
  })
})
