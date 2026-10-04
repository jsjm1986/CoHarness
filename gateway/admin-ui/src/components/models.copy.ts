/** Shared model row copy: role-default badges and the per-user override choices. */

export const zh = {
  roleAdmin: '管理员',
  roleUser: '用户',
  decisionAllow: '允许',
  decisionDeny: '拒绝',
  overrideInherit: '继承角色',
  overrideAllow: '允许',
  overrideDeny: '拒绝',
} satisfies Record<string, string>

/** Shared model row locale key union. */
export type ModelsCopyKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  roleAdmin: 'Admins',
  roleUser: 'Users',
  decisionAllow: 'allowed',
  decisionDeny: 'denied',
  overrideInherit: 'Inherit role',
  overrideAllow: 'Allow',
  overrideDeny: 'Deny',
} satisfies Record<ModelsCopyKey, string>
