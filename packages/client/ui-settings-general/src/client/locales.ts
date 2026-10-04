/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'title': '设置',
  'close': '关闭',
  'openDocument': '打开配置文件',
  'openDocument.error': '无法打开配置文件',
  'general.nav': '通用设置',
  'nav.compact.general': '通用',
  'nav.compact.models': '模型',
  'nav.compact.plugins': '插件',
  'nav.compact.presets': '预设',
  'connection.error': '连接异常，刷新重试',
  'connection.retry': '立即重连',
  'connection.connecting': '重新连接中',
  'connection.connected': '连接成功',
  'connection.reconnect': '连接异常，点击立即重连',
  'connection.restart': '连接中断，正在重试，点击立即重连',
  'shortcut.open': '打开设置',
  'developerTools.title': '显示代码工作视图',
  'developerTools.error': '保存失败，请重试',
  'developerTools.description': '开启后，显示轨迹、本轮代码差异，可选择完整的 Agent 预设切换',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'nav.compact.general': 'General',
  'nav.compact.models': 'Models',
  'nav.compact.plugins': 'Plugins',
  'nav.compact.presets': 'Presets',
  'connection.error': 'Disconnected — refresh to retry',
  'connection.retry': 'Reconnect now',
  'connection.connecting': 'Reconnecting',
  'connection.connected': 'Connected',
  'connection.reconnect': 'Disconnected — click to reconnect',
  'connection.restart': 'Connection lost, retrying — click to reconnect now',
  'shortcut.open': 'Open settings',
  'developerTools.title': 'Show coding view',
  'developerTools.error': 'Could not save. Please try again.',
  'developerTools.description': 'Shows trajectory and this turn’s code diff, and enables switching among the full Agent presets',
} satisfies Record<SettingsKey, string>
