import type { ProjectThemePolicy } from './projects.ts'

/** Project metadata and capabilities exposed to the user-facing settings panel. */
export interface ProjectConfigurationView {
  project: {
    id: number
    name: string
    origin?: 'admin' | 'user'
    owner?: { id: number; username: string; displayName: string } | null
    themePolicy: ProjectThemePolicy
  }
  /** Whether the authenticated account may mutate project configuration. */
  canManage: boolean
  /** Capabilities are explicit so the UI never guesses from role or mode. */
  capabilities: {
    themePolicy: boolean
    runtimeSettings: boolean
    projectModels: boolean
    members: boolean
    filesystem: false
  }
}
