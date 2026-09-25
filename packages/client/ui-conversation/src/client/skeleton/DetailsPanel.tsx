/** Explicitly addressed Tool details with an independent, cancellable history reader. */
import { Fragment, useEffect, useState } from 'react'
import { CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { shallowEqual } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot, RunningToolCall, ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { DetailsSlotProps } from '../contract/slots.ts'
import { findToolCall } from '../tool-node-reader.ts'
import css from './DetailsPanel.module.css'

/** Full props composed by reference from the contract (automatic shares & injected share). */
export type DetailsPanelProps = DetailsSlotProps

/**
 * Selected call material: the call's display name and args plus the frozen
 * block slice it came from. `block` is a snapshot-cached reference, so the
 * wrapper stays shallow-equal across unrelated snapshot frames; the settled /
 * running split is read off it with the `'kind' in block` discrimination
 * instead of duplicated as flags.
 */
interface CallMaterial {
  name: string
  argsRaw: string | null
  block: ToolCallBlock
}

/** Material of a settled result node (native call or run_code sub-dispatch). */
function settledMaterial(node: ToolResultNode, callId: string): CallMaterial {
  return { name: node.call?.name ?? callId, argsRaw: node.call?.argsRaw ?? null, block: node }
}

/** Material of an in-flight call (native call or run_code sub-dispatch). */
function runningMaterial(call: RunningToolCall): CallMaterial {
  return { name: call.name, argsRaw: call.argsRaw, block: call }
}

function materialFor(s: ConversationSnapshot, callId: string): CallMaterial | null {
  const found = findToolCall(s, callId)
  if (found === undefined) return null
  return 'kind' in found ? settledMaterial(found, callId) : runningMaterial(found)
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    // Not JSON (streaming fragment or plain text): show verbatim.
    return raw
  }
}

/** Flatten a settled result for the no-ui-tool fallback. */
function rawResultText(block: ToolCallBlock): string {
  if (!('kind' in block)) return ''
  const parts = block.content.map(item => item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
  return parts.join('\n')
}

export function DetailsPanel({
  useSession, useSessions, sessionId, callId, toolName, close, readEnabled = true, renderSlot, closeDetails, readCall, loadImage, t,
}: DetailsPanelProps) {
  // Session workspace root: an omitted or relative terminal cwd resolves
  // against it, which the pure presenter cannot see.
  const sessionCwd = useSessions(list => list.byId[sessionId]?.cwd)
  // materialFor builds a fresh wrapper; shallowEqual short-circuits on its
  // stable members (result node reference rides the snapshot's structural sharing).
  const liveMaterial = useSession(
    s => (callId === undefined ? null : materialFor(s, callId)),
    (a, b) => shallowEqual(a, b))

  const running = useSession(snapshot => snapshot.running)
  const [read, setRead] = useState<{ callId: string; material?: CallMaterial | null; error?: string }>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!readEnabled || callId === undefined || liveMaterial !== null) return
    const controller = new AbortController()
    setRead({ callId })
    void readCall(callId, controller.signal).then((block) => {
      if (controller.signal.aborted) return
      const material = block === undefined ? null : 'kind' in block ? settledMaterial(block, callId) : runningMaterial(block)
      setRead({ callId, material })
    }, (error: unknown) => {
      if (!controller.signal.aborted) setRead({ callId, error: error instanceof Error ? error.message : String(error) })
    })
    return () => { controller.abort() }
  }, [callId, liveMaterial, readCall, readEnabled, running, attempt])
  const currentRead = read?.callId === callId ? read : undefined
  const material = liveMaterial ?? currentRead?.material

  return (
    <div className={css.root}>
      <div className={css.header}>
        <div className={css.title}>
          {material?.name ?? toolName ?? t('details.title')}
        </div>
        <button
          type="button" className={css.close} aria-label={t('details.close')}
          onClick={() => { (close ?? closeDetails)() }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className={css.body}>
        {callId === undefined
          ? <div className={css.empty}>{t('details.empty')}</div>
          : material == null
            ? <div className={css.empty}>
              {currentRead?.error !== undefined
                ? <><div role="alert">{currentRead.error}</div><button type="button" onClick={() => { setAttempt(value => value + 1) }}>{t('details.retry')}</button></>
                : t(material === null ? 'details.notFound' : 'details.loading')}
            </div>
            : (
              <>
                {material.argsRaw !== null && (
                  <section className={css.section}>
                    <div className={css.sectionLabel}>{t('details.input')}</div>
                    <CodeBlock code={pretty(material.argsRaw)} lang="json" copyLabel={t('copy')} copiedLabel={t('copied')} />
                  </section>
                )}
                <section className={css.section}>
                  <div className={css.sectionLabel}>{t('details.output')}</div>
                  {/* Keyed by the selected call: the body owns per-call view
                      state (the terminal card's expand and copy), which React
                      would otherwise carry into the next selection because the
                      panel does not unmount between calls. */}
                  <Fragment key={callId}>
                    {renderSlot('conversation.details.tool', {
                      block: material.block,
                      cwd: sessionCwd,
                      renderMessageImages: owner => renderSlot('conversation.details.images', { ...owner, loadImage }),
                    }, {
                      fallback: 'kind' in material.block
                        ? (
                          <pre className={css.code} data-error={material.block.isError || undefined}>
                            {rawResultText(material.block)}
                          </pre>
                        )
                        : <div className={css.empty}>{t('details.running')}</div>,
                    })}
                  </Fragment>
                </section>
              </>
            )}
      </div>
    </div>
  )
}
