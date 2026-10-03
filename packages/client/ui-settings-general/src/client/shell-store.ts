/** Shared settings viewing state for its mouse and command entry points. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Deep-link target carried by a navigation request. */
export interface SettingsNavigationScope {
  readonly scope?: 'personal' | 'project'
  readonly projectId?: number
}

type State = { open: boolean; activeId: string | undefined; navigationScope: SettingsNavigationScope }
type Actions = {
  open(draft: State): void
  close(draft: State): void
  select(draft: State, id: string): void
  openSection(draft: State, id: string): void
  navigate(draft: State, id: string | undefined, scope: SettingsNavigationScope): void
}

/**
 * Declare the settings dialog state and its complete mutation API.
 * @returns one root-scoped store handle for the settings shell.
 */
export function createSettingsShellStore(): EngineStoreHandle<State, Actions> {
  return defineStore({
    init: (): State => ({ open: false, activeId: undefined, navigationScope: {} }),
    actions: {
      open: (d) => { d.open = true; d.navigationScope = {} },
      close: (d) => { d.open = false; d.activeId = undefined; d.navigationScope = {} },
      select: (d, id: string) => { d.activeId = id },
      openSection: (d, id: string) => { d.activeId = id; d.navigationScope = {}; d.open = true },
      navigate: (d, id: string | undefined, scope: SettingsNavigationScope) => {
        d.activeId = id
        d.navigationScope = scope
        d.open = true
      },
    },
  })
}
