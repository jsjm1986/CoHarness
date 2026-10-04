/** The admin surface's persisted display language. */

/** The dictionaries an admin page may be written against. */
export type AdminLanguage = 'zh' | 'en'

const STORAGE_KEY = 'coharness-admin-language'

/**
 * The persisted display language; Chinese is the default and the fallback for
 * pages without an English dictionary.
 * @returns the language choice.
 */
export function adminLanguage(): AdminLanguage {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh'
  } catch {
    // Storage may deny access under privacy modes; the surface stays Chinese.
    return 'zh'
  }
}

/**
 * Persist the display language; a reload applies it across every surface.
 * @param language - the language to render from the next load on.
 */
export function setAdminLanguage(language: AdminLanguage): void {
  try {
    localStorage.setItem(STORAGE_KEY, language)
  } catch {
    // Storage may deny access under privacy modes; the choice stays in memory nowhere.
  }
}

/** A copy dictionary pair over one key set; `zh` is the key source of truth, `en` its checked counterpart. */
export interface CopyPair<K extends string> { readonly zh: Record<K, string>; readonly en: Record<K, string> }

/** The translate seat every admin copy dictionary binds through: `{name}` placeholders interpolate from the parameters. */
export type CopyTranslate<K extends string> = (key: K, parameters?: Record<string, string>) => string

/**
 * Bind a dictionary pair to one language.
 * @param language - the display language to read.
 * @param pair - the zh/en dictionary pair.
 * @returns the translate seat for that dictionary.
 */
export function translateCopy<K extends string>(language: AdminLanguage, pair: CopyPair<K>): CopyTranslate<K> {
  const dictionary = language === 'en' ? pair.en : pair.zh
  return (key, parameters) => Object.entries(parameters ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), dictionary[key])
}
