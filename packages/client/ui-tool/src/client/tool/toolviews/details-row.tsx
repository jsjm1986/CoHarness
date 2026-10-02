/** Keyed recorded-result rows sharing the compact detail body. */
import { useMemo } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  IconAgentPresetOutline16, IconBranchOutline16, IconChecklistOutline14, IconClockOutline16,
  IconCodeOutline16, IconCordisPluginOutline14, IconGoalOutline16, IconSearchOutline16,
  IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { CONVERSATION_NS as NS } from '../../locale.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { detailsCardModel } from '../models/details-card-model.ts'
import { parsedToolCall } from '../models/raw-tool-call.ts'
import { toolRowModel } from '../models/tool-call-model.ts'

type DetailsRowProps = ToolCallViewProps & PropsLocale<'conversation'>

const LSP_TITLE_KEYS = {
  goToDefinition: 'tool.title.findDefinition',
  findReferences: 'tool.title.findReferences',
  goToImplementation: 'tool.title.findImplementation',
  hover: 'tool.title.hoverSymbol',
} as const

/** Teammate-coordination tools presented with the single-person teammate icon. */
const TEAMMATE_TOOLS = new Set(['spawn_teammate', 'list_agents', 'send_message', 'interrupt_agent', 'wait_agent'])

function detailIcon(toolName: string) {
  if (TEAMMATE_TOOLS.has(toolName)) return <IconUserOutline16 size={14} />
  if (toolName.startsWith('schedule_')) return <IconClockOutline16 size={14} />
  if (toolName.endsWith('_goal')) return <IconGoalOutline16 size={14} />
  if (toolName.startsWith('cordis_')) return <IconCordisPluginOutline14 />
  if (toolName.startsWith('terminal_')) return <IconCodeOutline16 size={14} />
  if (toolName.startsWith('session_') || toolName === 'lsp') return <IconSearchOutline16 size={14} />
  if (toolName.startsWith('job_') || toolName.startsWith('team_task_')) return <IconChecklistOutline14 />
  if (toolName === 'workflow' || toolName === 'ralph') return <IconBranchOutline16 size={14} />
  return <IconAgentPresetOutline16 size={14} />
}

/**
 * Present recorded entities, receipts, and report fields in the existing expandable row.
 * @param props - Tool call, row actions, and locale supplied by the keyed slot.
 * @returns A Tool row with structured details or generic input/output.
 */
export function DetailsRow({ useDisclosure, toolName, block, cwd, home, openFile, inspect, openDetails, t }: DetailsRowProps) {
  const model = toolRowModel(toolName, block, cwd, home)
  const locale = document.documentElement.lang
  const details = useMemo(() => detailsCardModel(block, t, locale), [block, t, locale])
  const operation = toolName === 'lsp' ? parsedToolCall(block)?.args.operation : undefined
  const titleKey = typeof operation === 'string' && Object.hasOwn(LSP_TITLE_KEYS, operation)
    ? LSP_TITLE_KEYS[operation as keyof typeof LSP_TITLE_KEYS]
    : model.titleKey
  return (
    <ToolRow
      useDisclosure={useDisclosure}
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={detailIcon(toolName)}
      title={t(titleKey)}
      summary={details?.summary ?? details?.items[0]?.title ?? details?.empty ?? model.summary}
      details={details}
      bodyRaw={model.bodyRaw}
      output={model.output}
      errorSummary={model.errorSummary}
      state={model.state}
      openDetails={openDetails}
      inspect={inspect}
      onOpenFile={openFile}
    />
  )
}

/** Register recorded-result details through the standard atomic Tool slot. */
export const detailsToolview = {
  name: 'details-toolview',
  inject: ['slots'],
  /**
   * Register the detail rows into the Tool-owned keyed view slot.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', function* () {
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'create_goal', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'get_goal', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'update_goal', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'schedule_create', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'schedule_list', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'schedule_delete', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'schedule_update', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'cordis_inspect_list', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'cordis_inspect_query', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'cordis_inspect_self', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'workflow', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'ralph', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'session_event_read', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'session_event_search', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'session_event_trace', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'session_search', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'session_trace', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'list_subagent_models', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'subagent', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'list_agents', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'send_message', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'interrupt_agent', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'job_list', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'job_output', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'job_kill', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'terminal_open', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'terminal_read', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'terminal_list', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'terminal_signal', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'terminal_close', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'lsp', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'spawn_teammate', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'team_task_create', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'team_task_get', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'team_task_update', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'team_task_list', locale: NS }, DetailsRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'wait_agent', locale: NS }, DetailsRow)
    })
  },
}
