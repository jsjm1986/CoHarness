// @vitest-environment jsdom
/** Desktop gestures honor current capability and abandon results from a revoked Session. */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { changedFileUrl } from '../src/changes.ts'
import { presentedFileUrl } from '../src/presented.ts'
import { PresentedOpenController } from '../src/client/present-open.ts'

const SESSION = SessionId('delivery-owner')

describe('PresentedOpenController', () => {
  it('checks capability for every gesture, keeps actions distinct, and redacts provider errors', async () => {
    let available = false
    const open = vi.fn<(path: string, action: 'open' | 'reveal', signal: AbortSignal) => Promise<void>>().mockResolvedValue()
    const controller = new PresentedOpenController(() => ({ available, name: '', fileManager: 'directory' }), open)
    await controller.loadHost()
    expect(controller.host.getSnapshot()).toMatchObject({ available: false })
    await controller.open(SESSION, 1, 0, 'open', 'report.txt')
    expect(open).not.toHaveBeenCalled()
    expect(controller.state.getSnapshot()[presentedFileUrl(SESSION, 1, 0)]).toBe('nativeUnavailable')
    available = true
    await controller.open(SESSION, 1, 0, 'reveal', 'report.txt')
    expect(open).toHaveBeenCalledWith('report.txt', 'reveal', expect.any(AbortSignal))
    expect(controller.state.getSnapshot()[presentedFileUrl(SESSION, 1, 0)]).toBe('revealed')
    open.mockRejectedValueOnce(new Error('/private/provider-secret'))
    await controller.openChanged(SESSION, 2, 0, 'report.txt')
    expect(controller.state.getSnapshot()[changedFileUrl(SESSION, 2, 0)]).toBe('error')
    expect(JSON.stringify(controller.state.getSnapshot())).not.toContain('provider-secret')
    await controller.openChanged(SESSION, 2, 0, 'report.txt')
    expect(controller.state.getSnapshot()[changedFileUrl(SESSION, 2, 0)]).toBe('opened')
    available = false
    await controller.openChanged(SESSION, 2, 0, 'report.txt')
    expect(open).toHaveBeenCalledTimes(3)
    await controller.dispose()
    expect(controller.state.getSnapshot()).toEqual({})
    expect(controller.host.getSnapshot()).toBeNull()
  })

  it('reports a failed directory open and ignores host reads after disposal', async () => {
    const open = vi.fn().mockRejectedValue(new Error('desktop unavailable'))
    const controller = new PresentedOpenController(() => ({ available: true, name: '', fileManager: 'directory' }), open)
    await controller.open(SESSION, 1, 0, 'reveal', 'report.txt')
    expect(controller.state.getSnapshot()[presentedFileUrl(SESSION, 1, 0)]).toBe('revealError')
    await controller.open(SESSION, 1, 0)
    expect(controller.state.getSnapshot()[presentedFileUrl(SESSION, 1, 0)]).toBe('nativeUnavailable')
    expect(open).toHaveBeenCalledOnce()
    await controller.dispose()
    await controller.loadHost()
    expect(controller.host.getSnapshot()).toBeNull()
  })

  it('deduplicates an in-flight gesture and waits for disposal without publishing its late result', async () => {
    let settle!: () => void
    const open = vi.fn<(path: string, action: 'open' | 'reveal', signal: AbortSignal) => Promise<void>>()
      .mockImplementation(() => new Promise<void>((resolve) => { settle = resolve }))
    const controller = new PresentedOpenController(() => ({ available: true, name: '', fileManager: 'directory' }), open)
    const request = controller.open(SESSION, 1, 0, 'open', 'report.txt')
    await controller.open(SESSION, 1, 0, 'open', 'report.txt')
    expect(open).toHaveBeenCalledOnce()
    const signal = open.mock.calls[0]![2]
    let disposed = false
    const disposal = controller.dispose().then(() => { disposed = true })
    expect(signal.aborted).toBe(true)
    expect(disposed).toBe(false)
    expect(controller.state.getSnapshot()).toEqual({})
    settle()
    await Promise.all([request, disposal])
    await controller.open(SESSION, 1, 0, 'open', 'report.txt')
    expect(open).toHaveBeenCalledOnce()
    expect(controller.state.getSnapshot()).toEqual({})
  })

  it('invalidates desktop capability and old responses on connection replacement', async () => {
    let settle!: () => void
    const open = vi.fn<(path: string, action: 'open' | 'reveal', signal: AbortSignal) => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve }))
      .mockResolvedValue()
    const controller = new PresentedOpenController(() => ({ available: true, name: '', fileManager: 'directory' }), open)
    await controller.loadHost()
    const stale = controller.open(SESSION, 1, 0, 'reveal', 'report.txt')
    controller.resetHost()
    expect(open.mock.calls[0]![2].aborted).toBe(true)
    expect(controller.host.getSnapshot()).toBeNull()
    await controller.open(SESSION, 1, 0, 'open', 'report.txt')
    settle()
    await stale
    expect(controller.state.getSnapshot()[presentedFileUrl(SESSION, 1, 0)]).toBe('opened')
    await controller.dispose()
  })
})
