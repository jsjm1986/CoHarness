/** Current-account desktop confirmation text. */
export const desktopZh = {
  title: '桌面使用确认', open: '桌面权限', close: '关闭', refresh: '重新检查', loading: '正在核验桌面权限…',
  description: '确认后，此根会话内的子智能体和 PTC 可以共享你的确认。新增参与者、另一根会话或桌面变化时需要重新确认。',
  root: '根会话', node: '运行节点', desktop: '桌面', account: '当前账户',
  granted: '你已确认此根会话使用该桌面。', unconfirmed: '你尚未确认此根会话使用该桌面。',
  ineligible: '此账户、项目或会话尚不满足桌面使用条件。请联系管理员核验资格。',
  unavailable: '此运行节点尚未配置受管桌面。', failed: '无法完成桌面确认，请刷新状态后重试。',
  disconnected: '连接中断，桌面确认已暂停。', confirm: '确认使用此桌面', withdraw: '撤回我的确认', saving: '正在保存…',
}
/** English keys match the current-account confirmation text. */
export const desktopEn: Record<keyof typeof desktopZh, string> = {
  title: 'Desktop confirmation', open: 'Desktop access', close: 'Close', refresh: 'Check again', loading: 'Checking desktop access…',
  description: 'Your confirmation is shared with child agents and PTC within this root session. New participants, another root or a changed desktop require confirmation again.',
  root: 'Root session', node: 'Execution node', desktop: 'Desktop', account: 'Current account',
  granted: 'You confirmed this root session may use this desktop.', unconfirmed: 'You have not confirmed this root session may use this desktop.',
  ineligible: 'This account, project or session is not eligible for desktop access. Ask an administrator to check its permissions.',
  unavailable: 'This runtime has no managed desktop configured.', failed: 'Desktop confirmation could not be completed. Refresh its status and retry.',
  disconnected: 'Connection lost. Desktop confirmation is paused.', confirm: 'Confirm this desktop', withdraw: 'Withdraw my confirmation', saving: 'Saving…',
}
/** Keys for the confirmation slot namespace. */
export type DesktopKey = keyof typeof desktopZh
