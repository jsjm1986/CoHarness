/**
 * Cordis YAML parsing and Loader-entry classification shared by repository checks.
 * @module scripts/cordis-yaml
 */

import { NOT_RESOLVED, defineScalarTag } from 'js-yaml'
import * as yaml from 'js-yaml'

/** A Loader `!!js` expression preserved as data instead of executed. */
export interface JsExpr {
  __jsExpr: string
}

const jsExprType = defineScalarTag<JsExpr>('tag:yaml.org,2002:js', {
  resolve: (source, isExplicit) => (isExplicit && source.length > 0 ? { __jsExpr: source } : NOT_RESOLVED),
  identify: isJsExpr,
})
const schema = yaml.JSON_SCHEMA.withTags(jsExprType)

/**
 * Parse a Cordis config while preserving Loader `!!js` expressions as data.
 * An empty document parses to `undefined` (js-yaml 4 returned undefined where
 * v5 throws), keeping the caller's handling of an absent YAML value unchanged.
 * Value-position `{{placeholder}}` scalars in test templates are quoted before
 * parsing: js-yaml 5 reads `{{token}}` as a flow mapping with a complex key,
 * which every schema rejects, while js-yaml 4 tolerated the shape.
 * @param source - Cordis YAML source text.
 * @returns the parsed YAML value.
 */
export function loadCordisYaml(source: string): unknown {
  const normalized = source.replace(/(:\s*)\{\{([^{}]+)\}\}/g, '$1"{{$2}}"')
  return normalized.trim() === '' ? undefined : yaml.load(normalized, { schema })
}

/**
 * Test whether a value is a preserved Loader `!!js` expression.
 * @param value - parsed YAML value.
 * @returns whether the value contains one preserved expression.
 */
export function isJsExpr(value: unknown): value is JsExpr {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).__jsExpr === 'string'
}

/**
 * Test whether a Loader entry owns nested entries in its `config` array.
 * @param value - parsed Loader entry.
 * @returns whether the entry is an explicit or package-named Cordis group.
 */
export function isCordisGroupEntry(value: unknown): value is Record<string, unknown> & { config: unknown[] } {
  return typeof value === 'object'
    && value !== null
    && Array.isArray((value as Record<string, unknown>).config)
    && ((value as Record<string, unknown>).group === true
      || (value as Record<string, unknown>).name === '@deepseek-ai/cordis-plugin-group')
}
