/** Root/subcall Tool composition with one keyed atomic dispatch path. */
import { memo, useMemo, type ReactNode } from 'react'
import { createSnapshotStore, type ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ToolCallHookContext, ToolCallOwnerProps, ToolCallPhaseProps, ToolTreeProps,
} from '../contract/slots.ts'
import { toolRowModel } from './models/tool-call-model.ts'
import { bindToolCallDisclosure } from './tool-call-disclosure.ts'
import { GenericToolCard } from './toolviews/GenericToolCard.tsx'
import css from './ToolCallTree.module.css'

/** Resolve a Tool call's current lifecycle stage for the owner share. */
function toolCallPhase(block: ToolCallBlock): ToolCallPhaseProps {
  if ('kind' in block) return { phase: 'result', block }
  return block.phase === 'preparing' ? { phase: 'preparing', block } : { phase: 'start', block }
}

/** Resolve a Tool call's wire name from its current stage. */
function callName(call: ToolCallPhaseProps): string {
  return call.phase === 'result' ? call.block.call?.name ?? '' : call.block.name
}

/** One atomic call dispatched through the Tool-owned keyed slot. */
const ToolCall = memo(function ToolCall({
  renderSlot, callId, toolName, call, assistant, openFile, selected, cwd, home, openCallDetails, inspectCall, nested,
  renderMessageImages, t, children,
}: Pick<ToolTreeProps, 'renderSlot' | 'openFile' | 'cwd' | 'inspectCall' | 'openCallDetails' | 'renderMessageImages' | 't'> & {
  callId: string
  toolName: string
  call: ToolCallPhaseProps
  assistant: ToolCallHookContext['assistant']
  selected: boolean
  home?: string | undefined
  nested?: boolean | undefined
  children?: ReactNode
}) {
  const preparing = call.phase === 'preparing'
  const hookContext = useMemo<ToolCallHookContext>(() => ({
    callId,
    assistant: preparing ? assistant : undefined,
    disclosure: createSnapshotStore(false),
  }), [assistant, callId, preparing])
  const useDisclosure = useMemo(
    () => bindToolCallDisclosure(hookContext.disclosure), [hookContext])
  const owner: ToolCallOwnerProps = useMemo(() => ({
    callId,
    toolName,
    useDisclosure,
    ...call,
    openFile,
    cwd,
    home,
    nested,
    renderMessageImages,
    openDetails: openCallDetails === undefined ? undefined : () => { openCallDetails(callId) },
    inspect: () => { inspectCall(callId) },
  }), [callId, toolName, useDisclosure, call, openFile, cwd, home, nested, renderMessageImages, openCallDetails, inspectCall])
  // An Auto-review denial is the call's whole story: route it through the
  // generic row so a keyed toolview cannot hide the denial behind its own card.
  const autoReviewDenied = useMemo(
    () => call.phase === 'result' && toolRowModel(toolName, call.block).autoReviewDenial !== null,
    [toolName, call],
  )
  return (
    <div
      className={css.callRow}
      data-chat-anchor-key={`call:${callId}`}
      data-chat-call-id={callId}
      data-selected={selected || undefined}
    >
      {autoReviewDenied
        ? <GenericToolCard {...owner} t={t} />
        : renderSlot('tool.call.toolview', owner, {
          entryKey: toolName,
          hookContext,
          fallback: <GenericToolCard {...owner} t={t} />,
        })}
      {children}
    </div>
  )
})

const ToolCallBranch = memo(function ToolCallBranch({
  renderSlot, block, assistant, selectedCallId, cwd, home, openFile, openCallDetails, inspectCall, nested, renderMessageImages, t,
}: Pick<ToolTreeProps, 'renderSlot' | 'selectedCallId' | 'cwd' | 'openFile' | 'inspectCall' | 'openCallDetails' | 'renderMessageImages' | 't'> & {
  block: ToolCallBlock
  assistant: ToolCallHookContext['assistant']
  home?: string | undefined
  nested?: boolean | undefined
}) {
  const call = useMemo(() => toolCallPhase(block), [block])
  return (
    <ToolCall
      renderSlot={renderSlot}
      callId={call.block.callId}
      toolName={callName(call)}
      call={call}
      assistant={assistant}
      openFile={openFile}
      selected={call.block.callId === selectedCallId}
      cwd={cwd}
      home={home}
      nested={nested}
      renderMessageImages={renderMessageImages}
      openCallDetails={openCallDetails}
      inspectCall={inspectCall}
      t={t}
    >
      {call.phase !== 'preparing' && call.block.subCalls.length > 0 ? (
        <div className={css.subCalls} data-subcalls>
          {call.block.subCalls.map(child => (
            <ToolCallBranch
              key={child.callId}
              renderSlot={renderSlot}
              block={child}
              assistant={assistant}
              selectedCallId={selectedCallId}
              cwd={cwd}
              home={home}
              nested
              renderMessageImages={renderMessageImages}
              openFile={openFile}
              openCallDetails={openCallDetails}
              inspectCall={inspectCall}
              t={t}
            />
          ))}
        </div>
      ) : null}
    </ToolCall>
  )
})

/**
 * Render one root Tool call and its recursive children through the same
 * atomic keyed dispatch.
 * @param props - whole-Tool owner data and the Tool-owned child-slot share.
 * @returns the Tool call tree.
 */
export function ToolCallTree({
  renderSlot, node, selectedCallId, cwd, openFile, openCallDetails, inspectCall, renderMessageImages, useHostDescription, t,
}: ToolTreeProps) {
  const home = useHostDescription(description => description?.home)
  // A preparing call's partial argument prefix lives on the owning Step's
  // assistant-step Location data; the source exists only for step-scoped roots.
  const assistant = node.location.kind === 'step'
    ? node.location.step.data.source('assistant-step')
    : undefined
  return (
    <ToolCallBranch
      renderSlot={renderSlot}
      block={node.data.root}
      assistant={assistant}
      selectedCallId={selectedCallId}
      cwd={cwd}
      home={home}
      openFile={openFile}
      openCallDetails={openCallDetails}
      inspectCall={inspectCall}
      renderMessageImages={renderMessageImages}
      t={t}
    />
  )
}
