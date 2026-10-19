/** `skill` namespace dictionaries for the dedicated tool row. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'skill'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'row.title': 'Skill',
  'row.preparing': '准备加载技能',
  'row.running': '正在加载 skill',
  'row.failed': 'skill 加载失败',
  'row.stopped': 'skill 加载已中止',
  'row.instructions': '说明',
  'row.inspect': '查看',
  'menu.userOnly': '仅用户',
  'preview.loading': '正在读取技能说明…',
  'preview.failed': '无法读取技能说明。请关闭后重试。',
  'preview.missing': '此会话无法使用该技能。',
} satisfies Record<string, string>

/** The skill namespace key union. */
export type SkillKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'row.title': 'Skill',
  'row.preparing': 'Preparing to load a skill',
  'row.running': 'Loading skill',
  'row.failed': 'Skill load failed',
  'row.stopped': 'Skill load stopped',
  'row.instructions': 'Instructions',
  'row.inspect': 'Inspect',
  'menu.userOnly': 'user-only',
  'preview.loading': 'Loading skill instructions…',
  'preview.failed': 'Could not load skill instructions. Close this preview and try again.',
  'preview.missing': 'This skill is unavailable in this session.',
} satisfies Record<SkillKey, string>
