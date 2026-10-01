/** Test-side binding of the plain preview resource face to a real registry source. */
import { useMemo, useSyncExternalStore } from 'react'
import { isWorkspaceAccessFailure, WorkspaceResourceError, parseWorkspaceResourceAddress, workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceResourceOpenRequest, WorkspaceResourceRegistry, WorkspaceResourceSource, WorkspaceResourceTarget } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspacePreviewResource } from '../src/client/components/WorkspaceFileTab.tsx'

/** Rebuild a request whose runtime target comes from the test's owning resolver. */
export function previewRequest(
  address: string,
  sessionId: WorkspaceResourceOpenRequest['sessionId'],
  runtimeTarget: WorkspaceResourceTarget,
): WorkspaceResourceOpenRequest {
  const parsed = parseWorkspaceResourceAddress(address)
  if (parsed === undefined || parsed.sessionId !== sessionId) throw new Error('File tab does not belong to this Session')
  return { ...parsed, address: workspaceResourceAddress(sessionId, parsed.path), runtimeTarget }
}

/** The test stand-in for the tab's `useWorkspaceResource` hook plus callbacks. */
export function usePreviewResource(
  resources: WorkspaceResourceRegistry,
  request: WorkspaceResourceOpenRequest,
): WorkspacePreviewResource {
  const source = useMemo<WorkspaceResourceSource>(() => resources.source(request), [resources, request])
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const callbacks = useMemo(() => ({
    reload: () => source.reload(),
    revoke: (message: string) => {
      resources.disconnect(request.runtimeTarget, new WorkspaceResourceError('access-revoked', message))
    },
  }), [source, resources, request])
  return useMemo(() => {
    const failure = state.error === undefined ? undefined : {
      message: state.error.message,
      ...state.error instanceof WorkspaceResourceError ? { code: state.error.code } : {},
    }
    return {
      metadata: {
        status: state.status,
        ...state.value === undefined ? {} : { value: state.value },
        ...failure === undefined ? {} : { error: failure },
        accessDenied: isWorkspaceAccessFailure(state.error),
      },
      ...callbacks,
    }
  }, [state, callbacks])
}

/** Render children with the test-bound resource face; subscription mirrors the real hook. */
export function PreviewResourceBinding({ resources, request, children }: {
  resources: WorkspaceResourceRegistry
  request: WorkspaceResourceOpenRequest
  children: (resource: WorkspacePreviewResource) => import('react').ReactNode
}) {
  return children(usePreviewResource(resources, request))
}
