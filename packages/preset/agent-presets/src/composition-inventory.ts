/** Read-only flattened plugin rows for Agent-preset inventory consumers. */

import { readFile } from 'node:fs/promises'
import { load } from 'js-yaml'
import type { FiberState } from '@deepseek-ai/cordis'
import { isJsExpr, type EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { entryListProblem } from './discovery.ts'
import type { PresetTrust } from './preset.ts'

/** Effective enablement of one composition row. */
export type CompositionRowEnablement = boolean | 'conditional'

/** One flattened plugin row named by a preset composition. */
export interface AgentPresetCompositionRow {
  /** Loader entry id, or null when the composition row has no id. */
  readonly entryId: string | null
  /** Module specifier named by the row. */
  readonly moduleName: string
  /** Effective enablement after ancestor groups. */
  readonly enabled: CompositionRowEnablement
  /** Raw disabled expression, when the row declares one. */
  readonly condition?: string
  /** Root fiber state when a standing mount supplies the row. */
  readonly fiberState?: FiberState
}

/** One preset identity and its flattened composition rows. */
export interface AgentPresetComposition {
  readonly id: string
  readonly trust: PresetTrust
  readonly name?: string
  readonly isDefault: boolean
  readonly broken?: string
  readonly rows: readonly AgentPresetCompositionRow[]
}

/** Evaluate one loader `!!js` node, leaving unresolved expressions conditional. */
export type DisabledExpressionEvaluator = (expression: string) => unknown

function disabledContribution(value: unknown, evaluateExpression: DisabledExpressionEvaluator): boolean | 'conditional' {
  if (isJsExpr(value)) {
    try {
      return Boolean(evaluateExpression(value.__jsExpr))
    } catch {
      return 'conditional'
    }
  }
  return Boolean(value)
}

function combineDisabled(outer: boolean | 'conditional', own: boolean | 'conditional'): boolean | 'conditional' {
  if (outer === true || own === true) return true
  if (outer === 'conditional' || own === 'conditional') return 'conditional'
  return false
}

interface RawRow {
  id?: unknown
  name: string
  group?: unknown
  config?: unknown
  disabled?: unknown
}

function flattenRows(
  rows: readonly unknown[],
  outerDisabled: boolean | 'conditional',
  evaluateExpression: DisabledExpressionEvaluator,
  result: AgentPresetCompositionRow[],
): void {
  for (const value of rows) {
    const row = value as RawRow
    const effective = combineDisabled(outerDisabled, disabledContribution(row.disabled, evaluateExpression))
    if (row.group === true) {
      flattenRows(row.config as readonly unknown[], effective, evaluateExpression, result)
      continue
    }
    result.push({
      entryId: typeof row.id === 'string' && row.id !== '' ? row.id : null,
      moduleName: row.name,
      enabled: effective === true ? false : effective === 'conditional' ? 'conditional' : true,
      ...isJsExpr(row.disabled) ? { condition: row.disabled.__jsExpr } : {},
    })
  }
}

/**
 * Parse and flatten one unmounted composition file.
 * @param path - absolute path to the composition file.
 * @param evaluateExpression - evaluator for loader `!!js` expressions.
 * @returns flattened rows, or a load/validation error for a broken file.
 */
export async function fileComposition(
  path: string,
  evaluateExpression: DisabledExpressionEvaluator,
): Promise<{ rows: AgentPresetCompositionRow[] } | { broken: string }> {
  let rows: unknown
  try {
    rows = load(await readFile(path, 'utf8'), { schema: entryListSchema })
  } catch (error) {
    /* v8 ignore next -- node:fs and js-yaml report Error instances for every native failure here */
    return { broken: error instanceof Error ? error.message : String(error) }
  }
  const problem = entryListProblem(rows)
  if (problem !== undefined) return { broken: problem }
  const result: AgentPresetCompositionRow[] = []
  flattenRows(rows as readonly unknown[], false, evaluateExpression, result)
  return { rows: result }
}

/**
 * Read rows from a live standing Loader tree, preserving evaluated state.
 * @param tree - standing Loader entry tree for one preset.
 * @returns flattened rows in loader order.
 */
export function mountedCompositionRows(tree: EntryTree): AgentPresetCompositionRow[] {
  const result: AgentPresetCompositionRow[] = []
  for (const entry of tree.entries()) {
    if (entry.options.group) continue
    result.push({
      entryId: entry.id,
      moduleName: entry.options.name,
      enabled: !entry.disabled,
      ...isJsExpr(entry.options.disabled) ? { condition: entry.options.disabled.__jsExpr } : {},
      ...entry.fiber === undefined ? {} : { fiberState: entry.fiber.state },
    })
  }
  return result
}
