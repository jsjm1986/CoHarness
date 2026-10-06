/** Public node settings metadata; executable commands and identity are not editable settings. */
export const NODE_CONFIG_FIELDS = [
  { key: 'HGW_PORT', label: 'Gateway 端口', group: 'network', kind: 'integer', help: '本机回环监听端口；修改后需同步外部反向代理。', unit: '1–65535' },
  { key: 'HGW_INTAKE_PORT', label: '用量接收端口', group: 'network', kind: 'integer', help: '仅供本机受鉴权运行时使用，不向公网开放。', unit: '1–65535' },
  { key: 'HGW_PUBLIC_ORIGINS', label: '公开访问地址', group: 'network', kind: 'origins', help: '逗号分隔的完整 origin。DNS、反向代理和 TLS 证书需先由运维配置。', unit: '' },
  { key: 'HGW_USERS_ROOT', label: '用户运行数据目录', group: 'paths', kind: 'directory', help: '改变用户 DSH_HOME，不移动数据库记录的 HOME。先维护停写、完整复制并按候选代次重登记清单；systemd 的旧 HOME 在新根外时需协调迁移。', unit: '绝对路径' },
  { key: 'HGW_PROJECT_RUNTIMES_ROOT', label: '项目运行数据目录', group: 'paths', kind: 'directory', help: '改变项目 DSH_HOME，不移动项目源码或 SSH 工作区。先维护停写、完整复制并按候选代次重登记清单；自定义存储位置不会自动改写。', unit: '绝对路径' },
  { key: 'HGW_PROJECTS_ROOT', label: '新建管理项目目录', group: 'paths', kind: 'directory', help: '只影响之后创建的项目，已有项目挂载保持数据库记录的路径。', unit: '绝对路径' },
  { key: 'HGW_USER_PROJECTS_ROOT', label: '新建个人项目目录', group: 'paths', kind: 'directory', help: '只影响之后创建的项目，不搬迁已有项目源码。', unit: '绝对路径' },
  { key: 'HGW_BACKUP_DIR', label: '备份目录', group: 'paths', kind: 'directory', help: '保存新备份和恢复前的保护副本；旧备份保留原位置。', unit: '绝对路径' },
  { key: 'HGW_DATABASE_URL_FILE', label: '数据库凭据文件', group: 'credentials', kind: 'optional-file', help: '只管理文件位置，不读取显示凭据；空值保留启动环境的数据库连接。普通配置应用不能切换到不同数据库。', unit: '绝对路径' },
  { key: 'HGW_PRINCIPAL_KEY_DIR', label: '请求签名密钥目录', group: 'credentials', kind: 'directory', help: '移动位置需保留相同密钥；密钥轮换使用专门流程。', unit: '绝对路径' },
  { key: 'HGW_RUNTIME_CREDENTIAL_DIR', label: '运行时凭据目录', group: 'credentials', kind: 'directory', help: '运行时凭据的受管位置；不提供凭据内容读回。', unit: '绝对路径' },
  { key: 'HGW_ORGANIZATION_MODEL_CREDENTIAL_KEY_FILE', label: '模型凭据主密钥文件', group: 'credentials', kind: 'file', help: '搬迁时逐字节核验，不能将更换文件等同于密钥轮换。', unit: '绝对路径' },
  { key: 'HGW_WEBHOOK_SECRET_KEY_FILE', label: 'Webhook 主密钥文件', group: 'credentials', kind: 'file', help: '搬迁时须保留原解密材料。', unit: '绝对路径' },
  { key: 'HGW_DEFAULT_ENV_FILE', label: '默认模型凭据文件', group: 'credentials', kind: 'optional-file', help: '仅管理路径；留空表示不向运行时预置该文件。已有个人密钥不受影响。', unit: '绝对路径或空值' },
  { key: 'HGW_INSTANCE_PORT_BASE', label: '运行时端口起点', group: 'runtime', kind: 'integer', help: '只影响新的端口分配，不改动已有实例端口。', unit: '1–65535' },
  { key: 'HGW_IDLE_TIMEOUT_MS', label: '空闲回收时间', group: 'runtime', kind: 'integer', help: '运行中任务、终端和有效资源持有仍阻止回收。', unit: '毫秒' },
  { key: 'HGW_READINESS_TIMEOUT_MS', label: '实例启动期限', group: 'runtime', kind: 'integer', help: '到期报告失败，不以超时掩盖启动错误。', unit: '毫秒' },
  { key: 'HGW_MEMORY_MAX', label: 'Linux 实例内存上限', group: 'runtime', kind: 'text', help: '仅 systemd 启动方式生效；macOS local 不提供进程级资源限制。', unit: '如 4G 或 infinity' },
  { key: 'HGW_CPU_QUOTA', label: 'Linux 实例 CPU 上限', group: 'runtime', kind: 'text', help: '仅 systemd 启动方式生效。', unit: '如 200% 或 infinity' },
] as const

export type NodeSettingKey = typeof NODE_CONFIG_FIELDS[number]['key']
export type NodeSettingValues = Record<NodeSettingKey, string>

/** Current-node identity bound to every configuration read and mutation. */
export interface NodeConfigurationIdentity {
  organizationId: string
  nodeId: string
}

/** A durable, explicit apply request; save alone never restarts a service. */
export interface NodeConfigurationOperation {
  id: string
  revision: number
  /** Database generation reviewed with this request; restoration invalidates earlier requests. */
  writeEpoch: string
  actor: number | null
  status: 'pending' | 'applying' | 'completed' | 'failed'
  requestedAt: string
  error: string | null
}

/** Non-secret desired and actual configuration shown in Admin. */
export interface NodeConfigurationView extends NodeConfigurationIdentity {
  revision: number
  runningRevision: number
  appliedRevision: number
  desired: NodeSettingValues
  effective: NodeSettingValues
  operation: NodeConfigurationOperation | null
  configFile: string
}
