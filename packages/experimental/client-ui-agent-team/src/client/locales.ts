/** Agent Teams Web dictionaries. */

/** Locale namespace owned by the Agent Teams Web UI. */
export const NS = 'agent-team'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  trigger: 'Agent Team',
  refresh: '刷新成员',
  close: '关闭',
  empty: '还没有共享任务',
  roster: '成员',
  tasks: '共享任务',
  lead: 'Lead',
  open: '打开 teammate 会话',
  current: '当前',
  owner: 'Owner',
  unowned: '未分配',
  blockedBy: '依赖',
  writeScopes: '写入范围',
  ready: '可开始',
  blocked: '被依赖阻塞',
  failure: '任务记录无效：{message}',
  'memberStatus.running': '运行中',
  'memberStatus.inactive': '未运行',
  'status.pending': '待处理',
  'status.in_progress': '进行中',
  'status.completed': '已完成',
  'task.expand': '展开',
  'task.collapse': '收起',
  'mode.label': '启用智能体团队协作',
  'mode.description': '通过共享任务板协调多个智能体的分工与进度，复杂任务表现更佳，token 开销也相应更高。',
  'mode.disabled': '团队协作已停用；开启后共享任务板与协作工具将可用。',
  'mode.failed': '无法确认智能体团队协作设置已保存，请重试：{message}',
  'disable.warning': '停用将停止共享任务工具和团队协调指令。',
  'disable.confirm': '确认停用',
  'disable.cancel': '取消',
} satisfies Record<string, string>

/** Agent Teams locale key union. */
export type TeamKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  trigger: 'Agent Team',
  refresh: 'Refresh members',
  close: 'Close',
  empty: 'No shared tasks yet',
  roster: 'Members',
  tasks: 'Shared tasks',
  lead: 'Lead',
  open: 'Open teammate session',
  current: 'Current',
  owner: 'Owner',
  unowned: 'Unowned',
  blockedBy: 'Blocked by',
  writeScopes: 'Write scopes',
  ready: 'Ready',
  blocked: 'Blocked by dependencies',
  failure: 'Invalid persisted task record: {message}',
  'memberStatus.running': 'Running',
  'memberStatus.inactive': 'Inactive',
  'status.pending': 'Pending',
  'status.in_progress': 'In progress',
  'status.completed': 'Completed',
  'task.expand': 'Show more',
  'task.collapse': 'Show less',
  'mode.label': 'Enable agent teamwork',
  'mode.description': 'Coordinate work and progress across agents with a shared task board for better results on complex tasks, with correspondingly higher token costs.',
  'mode.disabled': 'Agent teamwork is off; enable it to use the shared task board and coordination tools.',
  'mode.failed': 'Could not confirm the agent teamwork setting was saved. Try again: {message}',
  'disable.warning': 'Disabling stops shared task tools and team coordination guidance.',
  'disable.confirm': 'Disable',
  'disable.cancel': 'Cancel',
} satisfies Record<TeamKey, string>
