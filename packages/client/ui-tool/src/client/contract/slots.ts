/** Tool UI slot declarations and their composed component props. */
import type { HostDescriptionSource } from '@deepseek-ai/dsh-client-connection/client'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, SlotHookFactory,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  PreparingToolCall, StartedToolCall, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  AssistantChatData, RenderMessageImages,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Keyed atomic Tool call view, dispatched by the wire Tool name. Register
     * with `key: '<tool name>'` to own how one tool's calls render inside a
     * turn — the key domain is open, so there is no compile-time key set to
     * pick from and a typo simply never renders.
     *
     * Registering an occupied key replaces its view; unclaimed keys use the
     * generic tool row. The owner passes the call's identity, its frozen
     * lifecycle stage through explicit phase props, and the expansion state
     * (see ToolCallOwnerProps). Preparing blocks carry no dispatched
     * arguments; useToolCallArgumentsPartial optionally subscribes to their
     * raw prefix.
     */
    'tool.call.toolview': {
      kind: 'keyed'
      scope: 'session'
      owner: ToolCallOwnerProps
      hookContext: ToolCallHookContext
      inject: ToolCallInjected
    }
  }
}

/** Subscribe to this preparing call's raw argument prefix; other phases return an empty string. */
export type UseToolCallArgumentsPartial = () => string

/** Call-local sources supplied by the Tool tree to the slot's Hook binding. */
export interface ToolCallHookContext {
  readonly callId: string
  /** This call's Step source, present only while preparing. */
  readonly assistant: HostObservable<Readonly<AssistantChatData> | undefined> | undefined
}

/** Framework-bound subscriptions available to atomic Tool views on demand. */
export interface ToolCallInjected {
  hooks: {
    toolCallArgumentsPartial: SlotHookFactory<'tool.call.toolview', UseToolCallArgumentsPartial>
  }
}

/** Standard owner currency supplied to every atomic Tool view. */
export interface ToolCallCommonProps {
  /** Tool call identity, stable across running and settled forms. */
  callId: string
  /** Wire Tool name and keyed dispatch value. */
  toolName: string
  /** Session workspace root for relative summaries. */
  cwd?: string | undefined
  /** Host account home; POSIX home-rooted summaries display as `~`. */
  home?: string | undefined
  /** Open an argument path at its optional requested line through the Host. */
  openFile: (path: string, options?: { line?: number }) => void
  /**
   * Whether this call is a run_code sub-dispatch: nested calls persist no
   * presentationMeta and no wire views, so the owner carries the fact (the
   * node has no parent link).
   */
  nested?: boolean | undefined
  /**
   * Slot-backed image gallery renderer from the owning chat node; an absent
   * renderer keeps an image card's envelope text beside an empty gallery position.
   */
  renderMessageImages?: RenderMessageImages | undefined
  /** Open this exact call in an auxiliary detail tab. */
  openDetails?: (() => void) | undefined
  /** Inspect this call in the trajectory view when available. */
  inspect?: (() => void) | undefined
}

/** Stage-specific tool data; only start/result expose the dispatched call material. */
export type ToolCallPhaseProps =
  | { readonly phase: 'preparing'; readonly block: PreparingToolCall }
  | { readonly phase: 'start'; readonly block: StartedToolCall }
  | { readonly phase: 'result'; readonly block: ToolResultNode }

/** Common owner callbacks and the data admitted at the current tool stage. */
export type ToolCallOwnerProps = ToolCallCommonProps & ToolCallPhaseProps

/** Full props of a registered atomic Tool view. */
export type ToolCallViewProps = PropsRuntime<'tool.call.toolview'>

/** Existing argument/result business components exclude the preparation stage. */
export type StartedToolCallViewProps = Exclude<ToolCallViewProps, { readonly phase: 'preparing' }>

/** Injected Host description for POSIX home-path display. */
export type ToolHostDescriptionInjected = {
  hooks: {
    /** Current generation's Host description, bound by the slot renderer. */
    hostDescription: HostDescriptionSource
  }
}

/** Full props of the Tool call-tree renderer registered as a `tool-call` Chat Node. */
export type ToolTreeProps = PropsRuntime<'conversation.chat.node', 'tool-call'>
  & PropsRenderSlots<'tool.call.toolview'>
  & PropsLocale<'conversation'>
  & InjectFace<ToolHostDescriptionInjected>

/** Full props of the selected Tool output renderer in the details panel. */
export type ToolDetailsProps = PropsRuntime<'conversation.details.tool'>
  & PropsLocale<'conversation'>
  & InjectFace<ToolHostDescriptionInjected>
