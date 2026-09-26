/** Root/subcall Tool composition with one keyed atomic dispatch path. */
import { memo, useMemo, type ReactNode } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallOwnerProps, ToolTreeProps } from '../contract/slots.ts'
import { toolRowModel } from './models/tool-call-model.ts'
import { GenericToolCard } from './toolviews/GenericToolCard.tsx'
import css from './ToolCallTree.module.css'

/** Resolve a Tool call's wire name from either lifecycle form. */
function callName(node: ToolCallBlock): string {
  return 'kind' in node ? node.call?.name ?? '' : node.name
}

/** One atomic call dispatched through the Tool-owned keyed slot. */
const ToolCall = memo(function ToolCall({
  renderSlot, callId, toolName, block, openFile, selected, cwd, home, openCallDetails, inspectCall, nested, renderMessageImages,
  t, children,
}: Pick<ToolTreeProps, 'renderSlot' | 'openFile' | 'cwd' | 'inspectCall' | 'openCallDetails' | 'renderMessageImages' | 't'> & {
  callId: string
  toolName: string
  block: ToolCallBlock
  selected: boolean
  home?: string | undefined
  nested?: boolean | undefined
  children?: ReactNode
}) {
  const owner: ToolCallOwnerProps = useMemo(() => ({
    callId,
    toolName,
    block,
    openFile,
    cwd,
    home,
    nested,
    renderMessageImages,
    openDetails: openCallDetails === undefined ? undefined : () => { openCallDetails(callId) },
    inspect: () => { inspectCall(callId) },
  }), [callId, toolName, block, openFile, cwd, home, nested, renderMessageImages, openCallDetails, inspectCall])
  // An Auto-review denial is the call's whole story: route it through the
  // generic row so a keyed toolview cannot hide the denial behind its own card.
  const autoReviewDenied = useMemo(
    () => toolRowModel(toolName, block).autoReviewDenial !== null,
    [toolName, block],
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
          fallback: <GenericToolCard {...owner} t={t} />,
        })}
      {children}
    </div>
  )
})

const ToolCallBranch = memo(function ToolCallBranch({
  renderSlot, block, selectedCallId, cwd, home, openFile, openCallDetails, inspectCall, nested, renderMessageImages, t,
}: Pick<ToolTreeProps, 'renderSlot' | 'selectedCallId' | 'cwd' | 'openFile' | 'inspectCall' | 'openCallDetails' | 'renderMessageImages' | 't'> & {
  block: ToolCallBlock
  home?: string | undefined
  nested?: boolean | undefined
}) {
  return (
    <ToolCall
      renderSlot={renderSlot}
      callId={block.callId}
      toolName={callName(block)}
      block={block}
      openFile={openFile}
      selected={block.callId === selectedCallId}
      cwd={cwd}
      home={home}
      nested={nested}
      renderMessageImages={renderMessageImages}
      openCallDetails={openCallDetails}
      inspectCall={inspectCall}
      t={t}
    >
      {block.subCalls.length > 0 ? (
        <div className={css.subCalls} data-subcalls>
          {block.subCalls.map(child => (
            <ToolCallBranch
              key={child.callId}
              renderSlot={renderSlot}
              block={child}
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
  const block = node.data.root
  return (
    <ToolCallBranch
      renderSlot={renderSlot}
      block={block}
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
