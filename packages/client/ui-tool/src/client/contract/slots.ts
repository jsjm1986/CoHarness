/** Tool UI slot declarations and their composed component props. */
import type { HostDescriptionSource } from '@deepseek-ai/dsh-client-connection/client'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, SessionIdOf, SlotHookFactory,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  PreparingToolCall, SnapshotStore, StartedToolCall, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  AssistantChatData, RenderMessageImages,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Keyed atomic Tool call view, dispatched by the wire Tool name. Register
     * with `key: '<tool name>'` to own how one tool's calls render inside a
     * turn; the key domain is open, so a typo simply never renders.
     *
     * Registering an occupied key replaces its view; unclaimed keys use the
     * generic tool row. The owner passes the call's identity, frozen lifecycle
     * stage, and expansion state (see ToolCallOwnerProps); preparing blocks
     * carry no dispatched arguments.
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

/**
 * One row's expanded/collapsed state. The disclosure cell lives on the call's
 * Hook context, so a row-type swap (generic row to question row and back)
 * keeps the open state while a remount starts collapsed.
 */
export type UseDisclosure = () => {
  readonly expanded: boolean
  /** @param open - whether this disclosure is expanded. */
  readonly setExpanded: (open: boolean) => void
  readonly toggle: () => void
}

/** Call-local sources supplied by the Tool tree to the slot's Hook binding. */
export interface ToolCallHookContext {
  readonly callId: string
  /** This call's Step source, present only while preparing. */
  readonly assistant: HostObservable<Readonly<AssistantChatData> | undefined> | undefined
  /** Per-call expanded-state cell shared by every row form this call takes. */
  readonly disclosure: SnapshotStore<boolean>
}

/** Framework-bound subscriptions available to atomic Tool views on demand. */
export interface ToolCallInjected {
  hooks: {
    toolCallArgumentsPartial: SlotHookFactory<'tool.call.toolview', UseToolCallArgumentsPartial>
  }
}

/** Standard owner currency supplied to every atomic Tool view. */
export interface ToolCallCommonProps {
  /**
   * Stable Hook; each invocation owns its open state bound to this call's
   * disclosure cell, so the generic and question rows share expansion.
   */
  useDisclosure: UseDisclosure
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

/**
 * One settled `ask_user_question` call as its transcript row read it. The row
 * reads the questions from the recorded call JSON, and the answers from
 * whichever recorded them: its own result when the answer arrived in time, or
 * the `userQuestions` projection when a late reply settled the call.
 */
export interface UserQuestionRecord {
  /** The call's questions, with the option lists the panel renders. */
  readonly questions: readonly AskUserQuestionItem[]
  /** The recorded answer batch; an item with no selection and no custom text was skipped. */
  readonly answers: readonly AskUserQuestionAnswerItem[]
}

/**
 * Optional answer-panel provider consumed by the ask-question row. A timed
 * `ask_user_question` call stays answerable after its result is recorded, and
 * its panel can be closed, so the transcript row is the way back to it. A
 * composition without a question UI has no panel to show.
 */
export interface UserQuestionPanels {
  /**
   * Put one call's answer panel back in the composer, ahead of any other
   * pending question.
   * @param sessionId - Session the call belongs to.
   * @param callId - `ask_user_question` call whose panel to show.
   * @returns whether a panel for that call was there to show.
   */
  reveal(sessionId: SessionIdOf, callId: string): boolean
  /**
   * Show one settled call's recorded answers as a read-only panel, ahead of
   * any other pending question. Closing that panel drops it for good; the row
   * builds it again from the same record.
   * @param sessionId - Session the call belongs to.
   * @param callId - `ask_user_question` call whose record to show.
   * @param record - the call's questions and recorded answers.
   * @returns whether the panel was shown.
   */
  review(sessionId: SessionIdOf, callId: string, record: UserQuestionRecord): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional user-question answer-panel provider. */
    userQuestionPanels: UserQuestionPanels
  }
}

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
