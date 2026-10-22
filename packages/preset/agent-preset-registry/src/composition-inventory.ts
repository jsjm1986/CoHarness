/** Read-only flattened plugin rows for Agent-preset inventory consumers. */

import { readFile } from 'node:fs/promises'
import { load } from 'js-yaml'
import { FiberState } from '@deepseek-ai/cordis'
import { isJsExpr, type EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { entryListProblem } from './definition.ts'
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

/** Active module references and isolation diagnostics for one retained preset revision. */
export interface AgentPresetInspection {
  /** Preset identity; different retained revisions can share it. */
  readonly id: string
  /** Active modules, with the bases needed to resolve their package identities. */
  readonly modules: readonly {
    /** Configured module specifier. */
    readonly moduleName: string
    /** Declaring configuration's URL, when available. */
    readonly baseUrl?: string
    /** Whether bare specifiers use the application's module base. */
    readonly useHostBase: boolean
  }[]
  /** Services this revision published outside its isolated realm. */
  readonly leakedServices: readonly string[]
}

/** Read active module references without exposing Loader entries.
 * @param tree - the retained revision's tree.
 * @returns detached module references in Loader order.
 */
export function activeCompositionModules(tree: EntryTree): AgentPresetInspection['modules'] {
  const modules: Array<AgentPresetInspection['modules'][number]> = []
  for (const entry of tree.entries()) {
    if (entry.options.group || entry.disabled || entry.fiber?.state !== FiberState.ACTIVE) continue
    const ownerTree = entry.parent.tree
    const baseUrl = ownerTree.ctx.baseUrl
    modules.push({
      moduleName: entry.options.name,
      ...baseUrl === undefined ? {} : { baseUrl },
      useHostBase: ownerTree === tree,
    })
  }
  return modules
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
 * Flatten declared child plugins for diagnostics before a successful activation.
 * @param rows Parsed child entries.
 * @param evaluateExpression Loader-context evaluator for disabled expressions.
 * @returns Flattened entries or a configuration diagnostic.
 */
export function definitionComposition(
  rows: unknown,
  evaluateExpression: DisabledExpressionEvaluator,
): { rows: AgentPresetCompositionRow[] } | { broken: string } {
  const problem = entryListProblem(rows)
  if (problem !== undefined) return { broken: problem }
  const found: AgentPresetCompositionRow[] = []
  flattenRows(rows as readonly unknown[], false, evaluateExpression, found)
  return { rows: found }
}

/**
 * Read rows from a live standing Loader tree, preserving evaluated state.
 * @param tree - standing Loader entry tree for one preset.
 * @returns flattened rows in loader order.
 */
export function mountedCompositionRows(tree: EntryTree): AgentPresetCompositionRow[] {
  const result: AgentPresetCompositionRow[] = []
  const owner = tree.ctx.fiber.entry
  const prefix = owner === undefined ? '' : `${owner.id}:`
  for (const entry of tree.entries()) {
    if (entry.options.group) continue
    result.push({
      entryId: entry.id.slice(prefix.length),
      moduleName: entry.options.name,
      enabled: !entry.disabled,
      ...isJsExpr(entry.options.disabled) ? { condition: entry.options.disabled.__jsExpr } : {},
      ...entry.fiber === undefined ? {} : { fiberState: entry.fiber.state },
    })
  }
  return result
}
