/** `settings.theme` namespace dictionaries (the Appearance row's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'appearance.title': '外观',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.system': '跟随系统',
  'appearance.loading': '正在读取设置…',
  'appearance.saving': '保存中…',
  'appearance.saveFailed': '设置未能保存，请重试。',
  'appearance.projectReadOnly': '项目空间设置由项目运行时管理，请切换到个人空间修改个人偏好。',
  'appearance.providerReadOnly': '本部署的设置为只读。',
  'appearance.accountReadOnly': '这是账户级偏好；当前页面无法持久化账户设置。',
  'appearance.organizationReadOnly': '此设置由组织管理员管理。',
  'appearance.deploymentReadOnly': '此设置由部署管理员管理。',
  'appearance.unavailable': '本部署未提供可持久化的设置。',
  'appearance.projectForcedLight': '此项目由管理员统一使用浅色；你的账号偏好仍会在其他空间生效。',
  'appearance.projectForcedDark': '此项目由管理员统一使用深色；你的账号偏好仍会在其他空间生效。',
} satisfies Record<string, string>

/** The settings.theme namespace key union. */
export type ThemeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
  'appearance.loading': 'Loading settings…',
  'appearance.saving': 'Saving…',
  'appearance.saveFailed': 'The setting could not be saved. Try again.',
  'appearance.projectReadOnly': 'Project settings are managed by the runtime. Switch to Personal to edit your preferences.',
  'appearance.providerReadOnly': 'This deployment stores settings read-only.',
  'appearance.accountReadOnly': 'This is an account preference; account persistence is unavailable on this page.',
  'appearance.organizationReadOnly': 'This setting is managed by your organization administrator.',
  'appearance.deploymentReadOnly': 'This setting is managed by the deployment administrator.',
  'appearance.unavailable': 'This deployment does not provide persistent settings.',
  'appearance.projectForcedLight': 'This project is forced to light by its manager; your account preference still applies elsewhere.',
  'appearance.projectForcedDark': 'This project is forced to dark by its manager; your account preference still applies elsewhere.',
} satisfies Record<ThemeKey, string>
