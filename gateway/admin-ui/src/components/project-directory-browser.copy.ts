/** Project directory browser copy: host identity, breadcrumbs, entry list, and path errors. */

export const zh = {
  gatewayHost: 'Gateway 主机',
  scopeConfiguredRoots: '已配置目录',
  scopeFilesystem: '本机文件系统',
  breadcrumbsAria: '目录路径',
  loadingDirectory: '正在读取目录',
  backToCurrent: '返回当前目录',
  retry: '重试',
  emptyTitle: '没有可浏览的子目录',
  entriesAria: '子目录',
  openDirectory: '打开目录 {name}',
  showHidden: '显示隐藏目录 ({count})',
  truncatedNote: '仅显示前 1000 个目录',
  selectedCurrent: '已选择当前目录',
  useCurrent: '使用当前目录',
  errorNotAbsolute: '目录路径必须是 Gateway 主机上的绝对路径。',
  errorNotFound: '目录不存在或已经被移动。',
  errorNotDirectory: '所选路径不是目录。',
  errorInaccessible: 'Gateway 无权读取该目录。',
  errorOutsideRoot: '该目录不在服务器配置的项目根目录内。',
  errorReserved: '该目录由 Gateway 管理，不能用于项目。',
} satisfies Record<string, string>

/** Project directory browser locale key union. */
export type ProjectDirectoryBrowserCopyKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  gatewayHost: 'Gateway host',
  scopeConfiguredRoots: 'Configured directories',
  scopeFilesystem: 'Local filesystem',
  breadcrumbsAria: 'Directory path',
  loadingDirectory: 'Reading directory',
  backToCurrent: 'Back to current directory',
  retry: 'Retry',
  emptyTitle: 'No browsable subdirectories',
  entriesAria: 'Subdirectories',
  openDirectory: 'Open directory {name}',
  showHidden: 'Show hidden directories ({count})',
  truncatedNote: 'Only the first 1000 directories are shown',
  selectedCurrent: 'Current directory selected',
  useCurrent: 'Use current directory',
  errorNotAbsolute: 'The directory path must be an absolute path on the Gateway host.',
  errorNotFound: 'The directory does not exist or has been moved.',
  errorNotDirectory: 'The selected path is not a directory.',
  errorInaccessible: 'Gateway is not allowed to read this directory.',
  errorOutsideRoot: 'The directory is outside the server-configured project roots.',
  errorReserved: 'The directory is managed by Gateway and cannot be used for a project.',
} satisfies Record<ProjectDirectoryBrowserCopyKey, string>
