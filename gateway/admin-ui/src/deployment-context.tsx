/** One entry-owned deployment policy for the existing Admin application. @module */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { getDeploymentTopology } from './api.ts'
import type { DeploymentContext } from '../../src/deployment-protocol.ts'

interface State { value: DeploymentContext | null; error: boolean; refresh(): Promise<void> }
const Context = createContext<State>({ value: null, error: false, refresh: async () => {} })

/** Share verified policy without remounting pages or replacing their unsaved forms. @param props - existing Admin shell. */
export function DeploymentContextProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<DeploymentContext | null>(null)
  const [error, setError] = useState(false)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const flight = useRef<Promise<void> | undefined>(undefined)
  const queued = useRef<Promise<void> | undefined>(undefined)
  const refresh = useCallback((): Promise<void> => {
    const owner = lifetime.current
    if (owner === undefined || owner.signal.aborted) return Promise.resolve()
    if (flight.current !== undefined) {
      if (queued.current !== undefined) return queued.current
      const next = flight.current.then(() => {
        if (queued.current === next) queued.current = undefined
        if (lifetime.current === owner && !owner.signal.aborted) return refresh()
      })
      queued.current = next
      return next
    }
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(10_000)])
    const request = getDeploymentTopology(signal).then(next => {
      if (!owner.signal.aborted) { setValue(next); setError(false) }
    }).catch(() => { if (!owner.signal.aborted) setError(true) }).finally(() => { if (flight.current === request) flight.current = undefined })
    flight.current = request
    return request
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void refresh()
    const focus = () => { if (document.visibilityState !== 'hidden') void refresh() }
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('hgw-deployment-policy')
    if (channel !== undefined) channel.onmessage = focus
    window.addEventListener('focus', focus)
    window.addEventListener('hgw-deployment-policy-changed', focus)
    document.addEventListener('visibilitychange', focus)
    return () => {
      controller.abort(); channel?.close()
      if (lifetime.current === controller) { lifetime.current = undefined; flight.current = undefined; queued.current = undefined }
      window.removeEventListener('focus', focus); window.removeEventListener('hgw-deployment-policy-changed', focus)
      document.removeEventListener('visibilitychange', focus)
    }
  }, [refresh])
  useEffect(() => {
    if (value === null) return
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh() }, value.refreshAfterMs)
    return () => { clearInterval(timer) }
  }, [value?.refreshAfterMs, refresh])
  return <Context.Provider value={{ value, error, refresh }}>{children}</Context.Provider>
}

/** Read this document's ingress policy; changing a managed page target does not change it. @returns policy and retry action. */
export function useDeploymentContext(): State { return useContext(Context) }
