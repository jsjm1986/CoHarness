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
