/** Per-user qualification card copy: grant switch, revision source, save, and notices. */

export const zh = {
  updateFailed: '无法更新授权',
  noticeGranted: '已授予资格。',
  noticeRevoked: '资格已撤销，已通知运行中的会话重新核验。',
  errorReread: '{error}。请重新读取当前授权。',
  granted: '已授予',
  notGranted: '未授予',
  notGrantable: '不可授予',
  staleGrant: '授权已失效',
  revokeStale: '清除失效授权',
  loadingPolicy: '正在读取{name}授权…',
  reread: '重新读取授权',
  grantLabel: '授予此用户{name}资格',
  sourceDefault: '来源：默认拒绝',
  sourceAdmin: '来源：管理员设置 · 版本 {revision}',
  saving: '正在保存',
  saveLabel: '保存{name}授权',
} satisfies Record<string, string>

/** Per-user qualification card locale key union. */
export type UserQualificationCardCopyKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  updateFailed: 'The grant could not be updated',
  noticeGranted: 'The qualification has been granted.',
  noticeRevoked: 'The qualification has been revoked and running sessions have been notified to re-verify.',
  errorReread: '{error}. Reload the current grant.',
  granted: 'Granted',
  notGranted: 'Not granted',
  notGrantable: 'Not grantable',
  staleGrant: 'Grant ineffective',
  revokeStale: 'Clear stale grant',
  loadingPolicy: 'Loading the {name} grant…',
  reread: 'Reload grant',
  grantLabel: 'Grant this user the {name} qualification',
  sourceDefault: 'Source: denied by default',
  sourceAdmin: 'Source: set by an administrator · revision {revision}',
  saving: 'Saving',
  saveLabel: 'Save the {name} grant',
} satisfies Record<UserQualificationCardCopyKey, string>
