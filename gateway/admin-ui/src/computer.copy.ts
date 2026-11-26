/** Computer selection and declared management failures in the existing Admin shell. */
import { adminLanguage, translateCopy } from './language.ts'

export const zh = {
  personalRecoveryInstallationPending: '此电脑有已验证但尚未发布的个人恢复候选，维护备份暂不能覆盖它的完整归属。请先完成恢复，或在隔离原电脑前取消恢复，然后重试备份；不需要停止其他任务。',
  projectNameKeyNotConfigured: '主入口尚未配置项目名称查重密钥。请完成密钥配置后重试。',
  projectNameKeyIdentityMismatch: '项目名称查重密钥文件缺失、权限不符合要求或身份与指纹不匹配。请恢复已登记的原密钥文件；不要生成新密钥替代。',
  backupProjectNameKeyEvidenceMissing: '此备份缺少项目名称查重密钥的身份凭据，不能安全恢复。请选择包含完整密钥证据的备份。',
  backupProjectNameKeyIdentityAmbiguous: '无法从备份唯一确定项目名称查重密钥的身份。请核对备份来源及密钥登记，不要继续恢复。',
  backupProjectNameKeyLocationChanged: '备份中的项目名称查重密钥路径与当前配置不同。请先完成明确的路径迁移并重新预检。',
  projectNameKeyConfigurationChange: '不能在存储搬迁时新增或取消项目名称查重密钥配置。请先按项目名称密钥设置流程处理。',
  localHomeBindingRequired: '本机账号数据尚未核验。请在所属电脑的恢复审核中绑定原目录，再重试此操作；不会创建替代目录。',
  localHomeConflict: '此账号在本机已绑定其他数据目录。请核对原目录归属并使用已绑定的位置，不会覆盖现有数据。',
  conflict: '配置已被更新，请刷新后再修改', quotaExceeded: '已达到 Runtime 配额，请调整配额或退役不再使用的 Runtime',
  forbidden: '此操作未获授权，请检查账号与电脑使用权限', runtimeMissing: '此 Runtime 已不可用，请刷新列表',
  provisioning: 'Runtime 正在准备，请稍后刷新状态', runtimeUnavailable: '无法确认 Runtime 状态，请刷新后重试',
  identity: '电脑编号', scope: '配置范围', scopeDescription: '电脑权限与本机资源按此电脑管理；账号和组织设置统一管理。',
  label: '管理电脑', center: '中心电脑', selected: '电脑 {id}', connected: '已连接', disconnected: '未连接',
  choose: '管理电脑：{name}',
  detached: '独立运行', entryUnavailable: '当前入口已不能访问此环境，页面和未保存内容仍保留', openLocal: '在新标签页打开本机管理', policyFailed: '未能读取部署设置，请重新读取', retryPolicy: '重新读取部署设置',
  pending: '待接入', revoked: '已撤销', quarantined: '已隔离', refresh: '刷新电脑列表', more: '更多电脑', first: '返回首页',
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
  personalRecoveryInstallationPending: 'This computer has a verified personal recovery candidate that is not yet published. A maintenance backup cannot fully preserve its placement. Complete recovery, or cancel before isolating the source, then retry the backup. Other tasks do not need to stop.',
  projectNameKeyNotConfigured: 'The primary entry has no project-name uniqueness key configured. Configure it before retrying.',
  projectNameKeyIdentityMismatch: 'The registered project-name key file is missing, has unsafe permissions, or does not match its identity and fingerprint. Restore the registered original file; do not replace it with a new key.',
  backupProjectNameKeyEvidenceMissing: 'This backup has no project-name key identity evidence and cannot be restored safely. Select a backup containing complete key evidence.',
  backupProjectNameKeyIdentityAmbiguous: 'The backup does not identify one project-name key unambiguously. Check its source and key registration before restoring.',
  backupProjectNameKeyLocationChanged: 'The backed-up project-name key path differs from the current configuration. Complete an explicit path migration and run preflight again.',
  projectNameKeyConfigurationChange: 'Storage relocation cannot add or remove the project-name key configuration. Complete the project-name key setup procedure first.',
  localHomeBindingRequired: 'Local account data has not been verified. Bind its original directories in recovery review on the owning computer, then retry. No replacement directory is created.',
  localHomeConflict: 'This account is already bound to another home on this computer. Verify ownership and use the bound location; existing data is not overwritten.',
  detached: 'Independent', entryUnavailable: 'This entry can no longer access this environment. The page and unsaved input are retained.', openLocal: 'Open local administration in a new tab', policyFailed: 'Could not read deployment settings. Reload to try again.', retryPolicy: 'Reload deployment settings',
  conflict: 'Settings have changed. Refresh before editing again.', quotaExceeded: 'The Runtime limit has been reached. Adjust the limits or retire an unused Runtime.',
  forbidden: 'This operation is not authorized. Check account and computer access.', runtimeMissing: 'This Runtime is no longer available. Refresh the list.',
  provisioning: 'The Runtime is being prepared. Refresh its status shortly.', runtimeUnavailable: 'Could not confirm Runtime status. Refresh and try again.',
  identity: 'Computer ID', scope: 'Settings scope', scopeDescription: 'Computer permissions and local resources use this computer. Accounts and organization settings are shared.',
  label: 'Manage computer', center: 'Center computer', selected: 'Computer {id}', connected: 'Connected', disconnected: 'Disconnected',
  choose: 'Manage computer: {name}',
  pending: 'Pending enrollment', revoked: 'Revoked', quarantined: 'Quarantined', refresh: 'Refresh computers', more: 'More computers', first: 'First page',
  readFailed: 'Could not load computers. Refresh and try again.', denied: 'You do not have permission to list computers.',
  contextFailed: 'Could not load the center computer. Refresh and try again.', disabled: 'Multi-computer management is not enabled.',
  unavailable: 'Could not reach the selected computer. Check its connection and try again.', busy: 'The selected computer is busy. Try again shortly.',
  timeout: 'The selected computer did not respond in time. Try again.', mismatch: 'The selected computer identity changed. Select it again.',
  remoteDesktopUnavailable: 'Remote desktop is unavailable on this computer. Check its deployment settings and refresh.',
  desktopCoordinationUnavailable: 'Desktop coordination is unavailable on this computer. Check its deployment settings and refresh.',
  documentCatalogUnavailable: 'The document catalog is unavailable on this computer. Check its deployment settings and refresh.',
  cancelled: 'The computer connection was cancelled.', invalid: 'The computer selection is invalid. Select it again.', returnCenter: 'Return to the center computer',
} satisfies Record<ComputerCopyKey, string>

const declaredErrors: Readonly<Record<string, ComputerCopyKey>> = {
  'peer-backup/personal-recovery-installation-pending': 'personalRecoveryInstallationPending',
  'project-name-key-not-configured': 'projectNameKeyNotConfigured',
  'project-name-key-identity-mismatch': 'projectNameKeyIdentityMismatch',
  'backup-project-name-key-evidence-missing': 'backupProjectNameKeyEvidenceMissing',
  'backup-project-name-key-identity-ambiguous': 'backupProjectNameKeyIdentityAmbiguous',
  'backup-project-name-key-location-changed': 'backupProjectNameKeyLocationChanged',
  'project-name-key-configuration-change-requires-explicit-migration': 'projectNameKeyConfigurationChange',
  'deployment/remote-target-unavailable': 'entryUnavailable', 'node-access/mode-disabled': 'disabled',
  'remote-desktop-unavailable': 'remoteDesktopUnavailable', 'desktop-coordination-unavailable': 'desktopCoordinationUnavailable',
  'document-catalog-unavailable': 'documentCatalogUnavailable',
  'runtime-management/revision-conflict': 'conflict', 'computer-access/revision-conflict': 'conflict',
  'runtime-management/quota-exceeded': 'quotaExceeded', 'runtime-management/forbidden': 'forbidden', 'computer-access/forbidden': 'forbidden',
  'runtime-management/not-found': 'runtimeMissing', 'runtime-management/provisioning-pending': 'provisioning',
  'runtime-management/unavailable': 'runtimeUnavailable',
  'runtime-management/local-home-binding-required': 'localHomeBindingRequired',
  'peer-backup/governance-local-binding-required': 'localHomeBindingRequired',
  'peer-backup/governance-local-account-home-conflict': 'localHomeConflict',
  'node-service/unavailable': 'unavailable', 'node-service/closed': 'unavailable',
  'node-service/busy': 'busy', 'node-service/timeout': 'timeout', 'node-service/mismatch': 'mismatch',
  'node-service/cancelled': 'cancelled', 'node-service/invalid-target': 'invalid',
}

/**
 * Translate declared Admin failures while retaining unrecognized diagnostics.
 * @param message - Gateway diagnostic from a failed Admin request.
 * @param code - optional machine discriminator independent of the readable message.
 * @returns localized failure copy, or the original business diagnostic.
 */
export function computerErrorMessage(message: string, code = message): string {
  const key = declaredErrors[code] ?? declaredErrors[message]
  return key === undefined ? message : translateCopy(adminLanguage(), { zh, en })(key)
}
