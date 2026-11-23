/** Request-owned initial snapshot shared by DeploymentPage and its mounted sections. @module */
import { createContext, useContext, type ReactNode } from 'react'
import {
  AdminRequestError,
  type DeploymentOverviewSectionKey,
  type DeploymentOverviewSections,
  type DeploymentOverviewSlice,
} from './api.ts'
import { computerErrorMessage } from './computer.copy.ts'

/** Shared initial overview read status owned by one DeploymentPage mount. */
export interface DeploymentOverviewState {
  readonly status: 'loading' | 'ready' | 'fallback'
  readonly requested: ReadonlySet<DeploymentOverviewSectionKey>
  readonly sections: DeploymentOverviewSections | null
}

const DeploymentOverviewContext = createContext<DeploymentOverviewState | null>(null)

/**
 * Provide one DeploymentPage mount's aggregated initial overview to descendant sections.
 * @param props - instance-owned overview state and descendant section tree.
 * @returns context provider element.
 */
export function DeploymentOverviewProvider({
  value,
  children,
}: {
  value: DeploymentOverviewState
  children: ReactNode
}) {
  return <DeploymentOverviewContext.Provider value={value}>{children}</DeploymentOverviewContext.Provider>
}

/**
 * Read the enclosing DeploymentPage's initial overview state.
 * @returns shared overview state, or null when a section is rendered standalone.
 */
export function useDeploymentOverview(): DeploymentOverviewState | null {
  return useContext(DeploymentOverviewContext)
}

/**
 * Extract a section payload from an overview slice or throw a matching AdminRequestError.
 * @param slice - per-section result from `/admin/api/deployment/overview`.
 * @returns validated section payload.
 */
export function unwrapDeploymentOverviewSlice<T>(slice: DeploymentOverviewSlice<T>): T {
  if (slice.ok) return slice.value
  // Mirror adminRequest's responseError so localized copy and discriminator codes match the per-route reads.
  throw new AdminRequestError(slice.status, computerErrorMessage(slice.error, slice.code), slice.code ?? slice.error)
}
