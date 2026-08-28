/** `settings.locale` namespace dictionaries (the Language row's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'language.title': '语言',
  'language.loading': '正在读取设置…',
  'language.saving': '保存中…',
  'language.saveFailed': '设置未能保存，请重试。',
  'language.projectReadOnly': '项目空间设置由项目运行时管理，请切换到个人空间修改个人偏好。',
  'language.providerReadOnly': '本部署的设置为只读。',
  'language.accountReadOnly': '语言偏好属于当前账户，但账户存储暂时不可写。',
  'language.organizationReadOnly': '语言设置由组织管理员管理。',
  'language.deploymentReadOnly': '语言设置由部署管理员管理。',
  'language.unavailable': '本部署未提供可持久化的设置。',
} satisfies Record<string, string>

/** The settings.locale namespace key union. */
export type SettingsLocaleKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'language.title': 'Language',
  'language.loading': 'Loading settings…',
  'language.saving': 'Saving…',
  'language.saveFailed': 'The setting could not be saved. Try again.',
  'language.projectReadOnly': 'Project settings are managed by the runtime. Switch to Personal to edit your preferences.',
  'language.providerReadOnly': 'This deployment stores settings read-only.',
  'language.accountReadOnly': 'Language belongs to this account, but account storage is currently read-only.',
  'language.organizationReadOnly': 'Language is managed by the organization administrator.',
  'language.deploymentReadOnly': 'Language is managed by the deployment administrator.',
  'language.unavailable': 'This deployment does not provide persistent settings.',
} satisfies Record<SettingsLocaleKey, string>
