/** Copy owned by the remote-desktop sidebar feature. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    remoteDesktop: keyof typeof zh
  }
}

/** Simplified Chinese remote-desktop copy. */
export const zh = {
  title: '远程桌面', connecting: '正在读取桌面状态…', retry: '重试',
  consentTitle: '确认远程桌面访问',
  consentView: '你将实时查看 {node} 的桌面画面。',
  consentControl: '你将实时查看并操控 {node} 的桌面。',
  consentRecording: '此会话将被管理员录制。',
  consentAction: '确认并连接', attaching: '正在建立连接…',
  viewOnly: '仅查看', control: '可操控', disconnect: '断开连接', reconnect: '重新连接',
  desktop: '桌面', unavailable: '此远程桌面当前不可达。',
  forbidden: '你没有此远程桌面的访问授权，请联系管理员开通。',
  consentRequired: '授权已变更，请重新确认。',
  stale: '此桌面目标已失效，请刷新后重试。',
  failed: '远程桌面失败：{message}',
  closed: '连接已断开。',
  credentialsTitle: '输入桌面登录凭证', username: '用户名', password: '密码',
  credentialsAction: '登录',
  connectTitle: '连接远程桌面', connectDescription: '输入已配置的目标节点',
  nodeId: '节点标识', connect: '连接',
} satisfies Record<string, string>

/** English remote-desktop copy. */
export const en = {
  title: 'Remote desktop', connecting: 'Reading desktop status…', retry: 'Retry',
  consentTitle: 'Confirm remote desktop access',
  consentView: 'You will view the desktop of {node} in real time.',
  consentControl: 'You will view and control the desktop of {node} in real time.',
  consentRecording: 'This session will be recorded by an administrator.',
  consentAction: 'Confirm and connect', attaching: 'Establishing the connection…',
  viewOnly: 'View only', control: 'Control', disconnect: 'Disconnect', reconnect: 'Reconnect',
  desktop: 'Desktop', unavailable: 'This remote desktop is currently unreachable.',
  forbidden: 'You have no access grant for this remote desktop; ask an administrator.',
  consentRequired: 'The grants changed; confirm again.',
  stale: 'This desktop target is stale; refresh and try again.',
  failed: 'Remote desktop failed: {message}',
  closed: 'The connection closed.',
  credentialsTitle: 'Enter the desktop credentials', username: 'Username', password: 'Password',
  credentialsAction: 'Sign in',
  connectTitle: 'Connect to a remote desktop', connectDescription: 'Enter a configured target node',
  nodeId: 'Node id', connect: 'Connect',
} satisfies Record<keyof typeof zh, string>
