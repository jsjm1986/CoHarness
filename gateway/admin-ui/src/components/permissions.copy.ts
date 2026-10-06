/** Resource permission wrapper copy: the per-resource name, description, and saved notice each wrapper passes to ResourcePermissions. */

export const zh = {
  sshName: 'SSH',
  sshDescription: '默认不授权。项目空间同时需要用户资格、项目授权和已共享的连接。SSH 使用目标身份是部署拥有的 OpenSSH 别名；每位用户仍需独立资格。撤权会切断对应运行时的连接。',
  sshSaved: 'SSH 授权已保存；项目空间仍需同时具备用户资格、项目授权和已共享的连接。',
  terminalName: '终端',
  terminalDescription: '默认不授权。项目空间同时需要用户资格、项目授权和可写成员身份。终端仅创建者可读写；管理员只能列出和关闭他人的终端。撤权后等待进程清理，隐藏标签不会结束进程。',
  terminalSaved: '终端授权已保存；项目空间仍需同时具备用户资格、项目授权和可写成员身份。',
  desktopName: '桌面',
  desktopDescription: '默认不授权。项目空间同时需要用户资格、项目授权和可写成员身份。资格不替代用户对具体会话与桌面的确认，也不代表运行节点已具备桌面能力。',
  desktopSaved: '桌面授权已保存；用户仍需确认会话与桌面。',
  pluginName: '插件管理',
  pluginDescription: '默认不授权。项目空间同时需要用户资格与项目授权；个人空间仅需用户资格。授权不替代插件本身的管理约束与运行时确认。',
  pluginSaved: '插件管理授权已保存；项目空间仍需同时具备用户资格与项目授权。',
} satisfies Record<string, string>

/** Resource permission wrapper locale key union. */
export type PermissionsCopyKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  sshName: 'SSH',
  sshDescription: 'Denied by default. A project space additionally requires the user qualification, the project grant, and a shared connection. SSH connects under deployment-owned OpenSSH aliases, and each user still needs an independent qualification. Revocation severs the connection for the affected runtime.',
  sshSaved: 'The SSH grant was saved; project spaces still require the user qualification, the project grant, and a shared connection.',
  terminalName: 'Terminal',
  terminalDescription: 'Denied by default. A project space additionally requires the user qualification, the project grant, and writable membership. Only the creator can read and write a terminal; administrators can only list and close other users\' terminals. After revocation, processes are left to be cleaned up; hidden tabs do not terminate processes.',
  terminalSaved: 'The terminal grant was saved; project spaces still require the user qualification, the project grant, and writable membership.',
  desktopName: 'Desktop',
  desktopDescription: 'Denied by default. A project space additionally requires the user qualification, the project grant, and writable membership. The qualification does not replace the user\'s confirmation of a specific session and desktop, and does not mean the running node already has desktop capability.',
  desktopSaved: 'The desktop grant was saved; the user still has to confirm the session and desktop.',
  pluginName: 'Plugin management',
  pluginDescription: 'Denied by default. A project space additionally requires the user qualification and the project grant; a personal space only requires the user qualification. The grant does not replace the plugin\'s own management constraints or runtime confirmations.',
  pluginSaved: 'The plugin-management grant was saved; project spaces still require the user qualification and the project grant.',
} satisfies Record<PermissionsCopyKey, string>
