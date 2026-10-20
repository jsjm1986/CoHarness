/** Copy owned by the remote-desktop administration settings section. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    remoteDesktopAdmin: keyof typeof zh
  }
}

/** Simplified Chinese remote-desktop administration copy. */
export const zh = {
  nav: '远程桌面', heading: '远程桌面授权', grants: '授权', audit: '审计',
  refresh: '刷新', loading: '正在读取…', sessionRequired: '打开一个会话后管理远程桌面授权。',
  nodeId: '节点', desktop: '桌面', principal: '用户', level: '级别', scope: '范围',
  machine: '长期', session: '会话', sessionId: '会话 ID', expiresAt: '过期时间', recording: '录制',
  grantedBy: '授权人', createdAt: '创建时间', revoked: '已撤销', actions: '操作',
  grant: '授予', revoke: '撤销', setView: '设为仅查看', setControl: '设为可操控',
  includeRevoked: '显示已撤销', empty: '暂无授权记录', auditEmpty: '暂无审计事件',
  issueTitle: '新授权', issue: '签发授权', issuing: '正在签发…',
  view: '仅查看', control: '可操控',
  forbidden: '当前账户不是管理员，仅能看到自己的授权。',
  failed: '操作失败：{message}',
  colKind: '事件', colAt: '时间', colPrincipal: '用户', colTarget: '目标', colLevel: '级别',
} satisfies Record<string, string>

/** English remote-desktop administration copy. */
export const en = {
  nav: 'Remote desktop', heading: 'Remote desktop grants', grants: 'Grants', audit: 'Audit',
  refresh: 'Refresh', loading: 'Loading…', sessionRequired: 'Open a Session to administer remote-desktop grants.',
  nodeId: 'Node', desktop: 'Desktop', principal: 'Principal', level: 'Level', scope: 'Scope',
  machine: 'Machine', session: 'Session', sessionId: 'Session ID', expiresAt: 'Expires', recording: 'Recording',
  grantedBy: 'Granted by', createdAt: 'Created', revoked: 'Revoked', actions: 'Actions',
  grant: 'Grant', revoke: 'Revoke', setView: 'Set view', setControl: 'Set control',
  includeRevoked: 'Show revoked', empty: 'No grants yet', auditEmpty: 'No audit events yet',
  issueTitle: 'New grant', issue: 'Issue grant', issuing: 'Issuing…',
  view: 'View', control: 'Control',
  forbidden: 'This account is not an administrator; only its own grants are listed.',
  failed: 'Operation failed: {message}',
  colKind: 'Event', colAt: 'At', colPrincipal: 'Principal', colTarget: 'Target', colLevel: 'Level',
} satisfies Record<keyof typeof zh, string>
