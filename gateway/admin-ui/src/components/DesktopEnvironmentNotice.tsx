/** Node-local desktop evidence, independent of account grants, VNC targets and headless browsers. */
import { useEffect, useState } from 'react'
import { getDesktopEnvironment, type DesktopEnvironment } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { Button } from './ui.tsx'

const zh = {
  headless: '当前服务器未检测到图形桌面，不能直接使用本机屏幕共享或原生 Computer Use。文件、终端和已配置的无头浏览器可独立使用；其他已配置的 VNC 目标仍可连接。',
  unknown: '暂时无法确认此电脑的图形桌面状态。启用桌面操作前，请确认桌面会话、服务及系统权限均已准备好。',
  retry: '重新检查桌面',
}
const en: Record<keyof typeof zh, string> = {
  headless: 'No graphical desktop was detected on this server. Local screen sharing and native Computer Use are unavailable. Files, terminals and configured headless browsers remain independent; other configured VNC targets can still be used.',
  unknown: 'The graphical desktop state could not be verified. Check the desktop session, services and OS permissions before enabling desktop operations.',
  retry: 'Check desktop again',
}

/** Recheck desktop evidence without changing configuration or dismissing pending form edits. */
export function DesktopEnvironmentNotice() {
  const [value, setValue] = useState<DesktopEnvironment | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(true)
  const t = translateCopy(adminLanguage(), { zh, en })
  useEffect(() => {
    const lifetime = new AbortController()
    setBusy(true)
    getDesktopEnvironment(lifetime.signal).then(result => {
      if (!lifetime.signal.aborted) setValue(result)
    }, () => {
      if (!lifetime.signal.aborted) setValue({ state: 'unknown', reason: 'inspection-unavailable' })
    }).finally(() => { if (!lifetime.signal.aborted) setBusy(false) })
    return () => { lifetime.abort() }
  }, [attempt])
  if (value === null || value.state === 'detected') return null
  return <div className="desktopEnvironmentNotice" role="status">
    <p>{t(value.state === 'not-detected' ? 'headless' : 'unknown')}</p>
    <Button variant="secondary" disabled={busy} onClick={() => setAttempt(count => count + 1)}>{t('retry')}</Button>
  </div>
}
