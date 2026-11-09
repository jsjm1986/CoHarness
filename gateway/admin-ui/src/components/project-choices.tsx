/** Project labels for controls on one Admin computer. Browsing another setting only loads the governance directory. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getOwnerProjectDisplays, type Project } from '../api.ts'
import { adminLanguage } from '../language.ts'

/** Keep unresolved projects usable by number. A focused control can request one page or its explicitly selected IDs. */
export function useProjectChoices() {
  const [projects, setRows] = useState<Project[]>([])
  const rows = useRef<Project[]>([])
  const flight = useRef<{ controller: AbortController; key: string } | undefined>(undefined)
  const [state, setState] = useState<'idle' | 'reading' | 'ready' | 'error'>('idle')
  useEffect(() => () => { flight.current?.controller.abort() }, [])
  const setProjects = useCallback((next: Project[]) => {
    flight.current?.controller.abort()
    flight.current = undefined
    rows.current = next
    setRows(next)
    setState('idle')
  }, [])
  const readNames = useCallback((visible?: readonly number[]) => {
    const wanted = visible === undefined ? undefined : new Set(visible)
    const page = rows.current.filter(row => row.metadataOnNode && !row.ownerDisplayLoaded && (!wanted || wanted.has(row.id))).slice(0, 32)
    if (!page.length) return
    const key = page.map(row => row.id).join(',')
    if (flight.current?.key === key) return
    flight.current?.controller.abort()
    const controller = new AbortController()
    flight.current = { controller, key }
    setState('reading')
    void getOwnerProjectDisplays(page, controller.signal).then(displays => {
      if (controller.signal.aborted) return
      const next = rows.current.map(row => {
        const owner = displays.get(row.id)
        return owner ? { ...row, name: owner.name, ownerDisplayLoaded: true as const } : row
      })
      rows.current = next
      setRows(next)
      setState('ready')
    }, (cause: unknown) => {
      if (controller.signal.aborted) return
      if (cause && typeof cause === 'object' && 'status' in cause && (cause.status === 401 || cause.status === 403)) {
        const neutral = rows.current.map(row => {
          if (!row.metadataOnNode) return row
          const value = { ...row, name: `#${row.id}`, path: '' }
          delete value.ownerDisplayLoaded
          return value
        })
        rows.current = neutral
        setRows(neutral)
      }
      setState('error')
    }).finally(() => {
      if (flight.current?.controller === controller) flight.current = undefined
    })
  }, [])
  const language = adminLanguage()
  const moreNames = (visible?: readonly number[]) => (state === 'ready' || state === 'error')
    && projects.some(row => row.metadataOnNode && !row.ownerDisplayLoaded && (!visible || visible.includes(row.id)))
    ? <button type="button" className="tableLink" onClick={() => readNames(visible)}>{state === 'error'
      ? language === 'zh' ? '重试读取项目名称' : 'Retry project names'
      : language === 'zh' ? '更多项目名称' : 'More project names'}</button> : null
  return { projects, setProjects, readNames, moreNames }
}
