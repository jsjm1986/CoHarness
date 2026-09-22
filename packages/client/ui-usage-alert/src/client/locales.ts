/** `usage.alert` namespace dictionaries for the quota alert overlay. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'usage.alert'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'alert.title': '{threshold}% 用量提醒',
  'metric.tokens': '本月 Token 用量',
  'metric.companyCost': '本月公司模型成本',
  'alert.reached': '已达到额度的 {threshold}%。',
} satisfies Record<string, string>

/** The usage-alert namespace key union. */
export type UsageAlertKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The quota alert overlay's copy. */
    'usage.alert': UsageAlertKey
  }
}

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'alert.title': '{threshold}% usage alert',
  'metric.tokens': 'Token usage this month',
  'metric.companyCost': 'Company model cost this month',
  'alert.reached': 'has reached {threshold}% of the quota.',
} satisfies Record<UsageAlertKey, string>
