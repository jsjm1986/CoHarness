/** Computer selection and connection failures in the existing Admin shell. */
import { adminLanguage, translateCopy } from './language.ts'

export const zh = {
  conflict: '配置已被更新，请刷新后再修改', quotaExceeded: '已达到 Runtime 配额，请调整配额或退役不再使用的 Runtime',
  forbidden: '此操作未获授权，请检查账号与电脑使用权限', runtimeMissing: '此 Runtime 已不可用，请刷新列表',
  provisioning: 'Runtime 正在准备，请稍后刷新状态', runtimeUnavailable: '无法确认 Runtime 状态，请刷新后重试',
  identity: '电脑编号', scope: '配置范围', scopeDescription: '电脑权限与本机资源按此电脑管理；账号和组织设置统一管理。',
  label: '管理电脑', center: '中心电脑', selected: '电脑 {id}', connected: '已连接', disconnected: '未连接',
  detached: '独立运行', entryUnavailable: '当前入口已不能访问此环境，页面和未保存内容仍保留', openLocal: '在新标签页打开本机管理', policyFailed: '未能读取部署设置，请重新读取', retryPolicy: '重新读取部署设置',
  pending: '待接入', revoked: '已撤销', refresh: '刷新电脑列表', more: '更多电脑', first: '返回首页',
  readFailed: '无法读取电脑列表，请刷新重试', denied: '没有读取电脑列表的权限',
  contextFailed: '无法读取中心电脑信息，请刷新重试', disabled: '多电脑管理服务尚未启用',
  unavailable: '无法连接所选电脑，请检查连接后重试', busy: '所选电脑正在忙，请稍后重试',
  timeout: '连接所选电脑超时，请稍后重试', mismatch: '所选电脑身份发生变化，请重新选择',
  remoteDesktopUnavailable: '此电脑的远程桌面服务不可用，请检查部署配置后刷新',
  desktopCoordinationUnavailable: '此电脑的桌面协调服务不可用，请检查部署配置后刷新',
  documentCatalogUnavailable: '此电脑的文档目录服务不可用，请检查部署配置后刷新',
  cancelled: '电脑连接已取消', invalid: '电脑选择无效，请重新选择', returnCenter: '返回中心电脑',
} satisfies Record<string, string>

export type ComputerCopyKey = keyof typeof zh

export const en = {
  detached: 'Independent', entryUnavailable: 'This entry can no longer access this environment. The page and unsaved input are retained.', openLocal: 'Open local administration in a new tab', policyFailed: 'Could not read deployment settings. Reload to try again.', retryPolicy: 'Reload deployment settings',
  conflict: 'Settings have changed. Refresh before editing again.', quotaExceeded: 'The Runtime limit has been reached. Adjust the limits or retire an unused Runtime.',
  forbidden: 'This operation is not authorized. Check account and computer access.', runtimeMissing: 'This Runtime is no longer available. Refresh the list.',
  provisioning: 'The Runtime is being prepared. Refresh its status shortly.', runtimeUnavailable: 'Could not confirm Runtime status. Refresh and try again.',
  identity: 'Computer ID', scope: 'Settings scope', scopeDescription: 'Computer permissions and local resources use this computer. Accounts and organization settings are shared.',
  label: 'Manage computer', center: 'Center computer', selected: 'Computer {id}', connected: 'Connected', disconnected: 'Disconnected',
  pending: 'Pending enrollment', revoked: 'Revoked', refresh: 'Refresh computers', more: 'More computers', first: 'First page',
  readFailed: 'Could not load computers. Refresh and try again.', denied: 'You do not have permission to list computers.',
  contextFailed: 'Could not load the center computer. Refresh and try again.', disabled: 'Multi-computer management is not enabled.',
  unavailable: 'Could not reach the selected computer. Check its connection and try again.', busy: 'The selected computer is busy. Try again shortly.',
  timeout: 'The selected computer did not respond in time. Try again.', mismatch: 'The selected computer identity changed. Select it again.',
  remoteDesktopUnavailable: 'Remote desktop is unavailable on this computer. Check its deployment settings and refresh.',
  desktopCoordinationUnavailable: 'Desktop coordination is unavailable on this computer. Check its deployment settings and refresh.',
  documentCatalogUnavailable: 'The document catalog is unavailable on this computer. Check its deployment settings and refresh.',
  cancelled: 'The computer connection was cancelled.', invalid: 'The computer selection is invalid. Select it again.', returnCenter: 'Return to the center computer',
} satisfies Record<ComputerCopyKey, string>

const connectionErrors: Readonly<Record<string, ComputerCopyKey>> = {
  'deployment/remote-target-unavailable': 'entryUnavailable', 'node-access/mode-disabled': 'disabled',
  'remote-desktop-unavailable': 'remoteDesktopUnavailable', 'desktop-coordination-unavailable': 'desktopCoordinationUnavailable',
  'document-catalog-unavailable': 'documentCatalogUnavailable',
  'runtime-management/revision-conflict': 'conflict', 'computer-access/revision-conflict': 'conflict',
  'runtime-management/quota-exceeded': 'quotaExceeded', 'runtime-management/forbidden': 'forbidden', 'computer-access/forbidden': 'forbidden',
  'runtime-management/not-found': 'runtimeMissing', 'runtime-management/provisioning-pending': 'provisioning',
  'runtime-management/unavailable': 'runtimeUnavailable',
  'node-service/unavailable': 'unavailable', 'node-service/closed': 'unavailable',
  'node-service/busy': 'busy', 'node-service/timeout': 'timeout', 'node-service/mismatch': 'mismatch',
  'node-service/cancelled': 'cancelled', 'node-service/invalid-target': 'invalid',
}

/**
 * Translate declared computer and Runtime management failures while retaining other diagnostics.
 * @param message - Gateway diagnostic from a failed Admin request.
 * @returns localized connection copy, or the original business diagnostic.
 */
export function computerErrorMessage(message: string): string {
  const key = connectionErrors[message]
  return key === undefined ? message : translateCopy(adminLanguage(), { zh, en })(key)
}
