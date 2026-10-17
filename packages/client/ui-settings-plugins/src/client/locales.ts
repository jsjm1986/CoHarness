/** Locale bundles for the plugin configuration cards on the Plugins page. */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin configuration card copy. */
    'settings.plugins': PluginsSettingsLocaleKey
  }
}

/** Locale keys these surfaces render. */
export type PluginsSettingsLocaleKey =
  | 'subagentModelSelectionAllowed' | 'subagentModelSelectionChoose' | 'subagentModelSelectionConflict'
  | 'subagentModelSelectionEmpty' | 'subagentModelSelectionLoadFailed' | 'subagentModelSelectionLoading'
  | 'subagentModelSelectionOff' | 'subagentModelSelectionPartial' | 'subagentModelSelectionRequired'
  | 'subagentModelSelectionRetry' | 'subagentModelSelectionTitle' | 'subagentModelSelectionToggle'
  | 'subagentModelSelectionUnavailable' | 'subagentModelSelectionUnavailableGroup'
  | 'overridden' | 'reset' | 'readOnly' | 'readOnlyProject' | 'readOnlyAccount' | 'readOnlyOrganization' | 'readOnlyDeployment'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidNumber'
  | 'bashTitle' | 'bashDescription' | 'bashTimeoutMs' | 'bashTimeoutMsHint'
  | 'bashMaxOutputBytes' | 'bashMaxOutputBytesHint'
  | 'agentLoopTitle' | 'agentLoopDescription' | 'agentLoopMaxParallel' | 'agentLoopMaxParallelHint'
  | 'subagentTitle' | 'subagentDescription' | 'subagentMaxDepth' | 'subagentDepthHelpLabel' | 'subagentDepthHelp' | 'subagentDepthZero' | 'subagentDepthOne'
  | 'subagentDepthOverride' | 'subagentMaxActive' | 'subagentCapacityHelpLabel' | 'subagentCapacityHelp' | 'subagentDepthInvalid' | 'subagentCapacityInvalid'
  | 'webSearchTitle' | 'webSearchDescription'
  | 'webSearchApiKey' | 'webSearchApiKeyHint' | 'webSearchApiKeyManaged' | 'webSearchApiKeySet' | 'webSearchApiKeyUnset'
  | 'webSearchBaseUrl' | 'webSearchBaseUrlHint' | 'webSearchMaxUses' | 'webSearchMaxUsesHint'
  | 'webSearchUseSearchApi' | 'webSearchUseSearchApiHint' | 'webSearchSearchGuide' | 'webSearchSearchGuideUrl'
  | 'webSearchApiBaseUrl' | 'webSearchApiBaseUrlHint' | 'webSearchCount' | 'webSearchCountHint' | 'webSearchInvalidCount'

/** English copy. */
export const en: Record<PluginsSettingsLocaleKey, string> = {
  subagentModelSelectionTitle: 'Model selection',
  subagentModelSelectionToggle: 'Allow agents to choose models for Subagents',
  subagentModelSelectionChoose: 'When enabled, agents can choose a provider, model, and reasoning effort for each Subagent from the authorized models below. Applies only to new sessions.',
  subagentModelSelectionAllowed: 'Models agents may choose',
  subagentModelSelectionLoading: 'Loading models…',
  subagentModelSelectionLoadFailed: 'Models could not be loaded.',
  subagentModelSelectionRetry: 'Retry',
  subagentModelSelectionPartial: 'Some model providers could not be loaded; saved choices remain removable.',
  subagentModelSelectionUnavailable: 'Currently unavailable',
  subagentModelSelectionUnavailableGroup: 'Saved but currently unavailable',
  subagentModelSelectionEmpty: 'No model provider currently advertises a model.',
  subagentModelSelectionRequired: 'Select at least one model before saving.',
  subagentModelSelectionConflict: 'Settings changed elsewhere. Discard your draft and try again.',
  subagentModelSelectionOff: 'Subagents use configured defaults or inherit the parent agent\'s model. Saved model choices are retained.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  readOnlyProject: 'This setting affects the shared project runtime and is managed by the project owner or an organization administrator.',
  readOnlyAccount: 'This setting belongs to the current account.',
  readOnlyOrganization: 'This setting is managed by the organization.',
  readOnlyDeployment: 'This setting is managed by the deployment.',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  bashTitle: 'Terminal',
  bashDescription: 'Limits every command the agent runs.',
  bashTimeoutMs: 'Command timeout (ms)',
  bashTimeoutMsHint: 'How long one command may run before it is terminated.',
  bashMaxOutputBytes: 'Output cap per stream (bytes)',
  bashMaxOutputBytesHint: 'Output beyond this spills to a temporary file rather than being lost.',
  agentLoopTitle: 'Agent loop',
  agentLoopDescription: 'How the agent dispatches tool calls.',
  agentLoopMaxParallel: 'Parallel tool calls',
  agentLoopMaxParallelHint: 'Upper bound on parallel-safe calls running at once within one step.',
  subagentTitle: 'Subagent',
  subagentDescription: 'Set Subagent recursion depth and parallelism.',
  subagentMaxDepth: 'Maximum recursion depth',
  subagentDepthHelpLabel: 'About maximum recursion depth',
  subagentDepthHelp: 'Limits how many levels of Subagents an Agent can create.',
  subagentDepthZero: 'Disable Subagents',
  subagentDepthOne: 'Only the main Agent can create Subagents',
  subagentDepthOverride: 'If a tool defines its own maximum recursion depth, that setting takes precedence.',
  subagentMaxActive: 'Subagent parallelism limit',
  subagentCapacityHelpLabel: 'About the Subagent parallelism limit',
  subagentCapacityHelp: 'Total live Subagents under the same main Agent, across all recursion levels. The main Agent is excluded. New start requests are rejected when the limit is reached.',
  subagentDepthInvalid: 'Enter a whole number of 0 or more.',
  subagentCapacityInvalid: 'Enter a whole number of 1 or more.',
  webSearchTitle: 'Web search',
  webSearchDescription: 'The DeepSeek search provider.',
  webSearchApiKey: 'API key',
  webSearchApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  webSearchApiKeyManaged: 'This key is managed by the deployment administrator and cannot be changed in the project scope.',
  webSearchApiKeySet: 'A key is configured.',
  webSearchApiKeyUnset: 'No key is configured; only conversations using a DeepSeek Account model can search, through the default endpoint.',
  webSearchBaseUrl: 'Messages API base URL',
  webSearchBaseUrlHint: 'Include the API prefix, such as https://api.deepseek.com/anthropic/v1. The provider appends /messages. Leave blank to restore the default.',
  webSearchMaxUses: 'Max searches per request',
  webSearchMaxUsesHint: 'How many searches the auxiliary model may run within one Messages request. Applies only to the Messages API.',
  webSearchUseSearchApi: 'Use the new Web Search API',
  webSearchUseSearchApiHint: 'Off by default: search runs through DeepSeek Messages. For the new Web Search API\'s features and pricing, see the ',
  webSearchSearchGuide: 'Search & Fetch guide',
  webSearchSearchGuideUrl: 'https://api-docs.deepseek.com/guides/search',
  webSearchApiBaseUrl: 'Search / Fetch API base URL',
  webSearchApiBaseUrlHint: 'Include the API prefix, such as https://api.deepseek.com/v1/tools. The provider appends /search or /fetch. Leave blank to restore the default.',
  webSearchCount: 'Results per search',
  webSearchCountHint: 'Results returned per query: an integer from 1 to 50, default 10. This controls result count, not search calls. web_search keeps no more sources than its own result limit.',
  webSearchInvalidCount: 'Enter an integer from 1 to 50, or leave blank to use the default.',
}

/** Simplified Chinese copy. */
export const zh: Record<PluginsSettingsLocaleKey, string> = {
  subagentModelSelectionTitle: '模型选择',
  subagentModelSelectionToggle: '允许 Agent 为子智能体选择模型',
  subagentModelSelectionChoose: '开启后，Agent 可以从下方授权模型中，为每个子智能体选择提供方、模型和推理强度。仅影响新会话。',
  subagentModelSelectionAllowed: 'Agent 可选择的模型',
  subagentModelSelectionLoading: '正在加载模型…',
  subagentModelSelectionLoadFailed: '无法加载模型。',
  subagentModelSelectionRetry: '重试',
  subagentModelSelectionPartial: '部分模型提供方暂时无法加载；已保存的选择仍可移除。',
  subagentModelSelectionUnavailable: '当前不可用',
  subagentModelSelectionUnavailableGroup: '已保存但当前不可用',
  subagentModelSelectionEmpty: '当前没有模型提供方公布模型。',
  subagentModelSelectionRequired: '保存前请至少选择一个模型。',
  subagentModelSelectionConflict: '设置已在其他位置更新。请放弃修改后重试。',
  subagentModelSelectionOff: '关闭后，子智能体使用配置的默认模型或继承父 Agent 的模型；已选模型会保留。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  readOnlyProject: '此设置会影响项目共享运行时，由项目 owner 或组织管理员管理。',
  readOnlyAccount: '此设置属于当前账户。',
  readOnlyOrganization: '此设置由组织管理员管理。',
  readOnlyDeployment: '此设置由部署管理员管理。',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
  bashTitle: '终端',
  bashDescription: '限制 agent 运行的每一条命令。',
  bashTimeoutMs: '命令超时（毫秒）',
  bashTimeoutMsHint: '单条命令允许运行多久，超时即终止。',
  bashMaxOutputBytes: '单流输出上限（字节）',
  bashMaxOutputBytesHint: '超出部分会转存到临时文件，而不是被丢弃。',
  agentLoopTitle: 'Agent 循环',
  agentLoopDescription: 'Agent 如何派发工具调用。',
  agentLoopMaxParallel: '并行工具调用数',
  agentLoopMaxParallelHint: '同一步内最多同时运行多少个可并行的调用。',
  subagentTitle: '子智能体',
  subagentDescription: '设置子智能体的递归层级和并行数量。',
  subagentMaxDepth: '最大递归深度',
  subagentDepthHelpLabel: '最大递归深度说明',
  subagentDepthHelp: '限制 Agent 创建子智能体的递归层级。',
  subagentDepthZero: '禁用子智能体',
  subagentDepthOne: '仅允许主 Agent 创建子智能体',
  subagentDepthOverride: '如果某个工具单独设置了最大递归深度，以该工具的设置为准。',
  subagentMaxActive: '子智能体并行数量上限',
  subagentCapacityHelpLabel: '子智能体并行数量上限说明',
  subagentCapacityHelp: '同一主 Agent 下，所有递归层级同时存活的子智能体总数，主 Agent 不计入。达到上限时，新的启动请求会被拒绝。',
  subagentDepthInvalid: '请输入不小于 0 的整数。',
  subagentCapacityInvalid: '请输入不小于 1 的整数。',
  webSearchTitle: '网页搜索',
  webSearchDescription: 'DeepSeek 搜索提供方。',
  webSearchApiKey: 'API Key',
  webSearchApiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
  webSearchApiKeyManaged: '此密钥由部署管理员管理，项目空间中不能修改。',
  webSearchApiKeySet: '已配置密钥。',
  webSearchApiKeyUnset: '未配置密钥；仅使用 DeepSeek 账号模型的对话可以通过默认接口地址搜索。',
  webSearchBaseUrl: 'Messages API 基础地址',
  webSearchBaseUrlHint: '填写含 API 前缀的地址，例如 https://api.deepseek.com/anthropic/v1；程序追加 /messages，留空恢复默认。',
  webSearchMaxUses: '单次请求最多搜索次数',
  webSearchUseSearchApi: '启用新版 Web 搜索 API',
  webSearchUseSearchApiHint: '默认关闭，搜索通过 DeepSeek Messages 完成。新版 Web 搜索 API 功能与计费详见',
  webSearchSearchGuide: '网页搜索与抓取指南',
  webSearchSearchGuideUrl: 'https://api-docs.deepseek.com/zh-cn/guides/search',
  webSearchApiBaseUrl: 'Search / Fetch API 基础地址',
  webSearchApiBaseUrlHint: '填写含 API 前缀的地址，例如 https://api.deepseek.com/v1/tools；程序追加 /search 或 /fetch，留空恢复默认。',
  webSearchCount: '每次搜索结果数',
  webSearchCountHint: '每个查询返回的结果条数，须为 1–50 的整数，默认 10；不控制搜索调用次数。web_search 保留的来源数不超过其自身的结果上限。',
  webSearchInvalidCount: '请填 1–50 的整数；留空表示使用默认值。',
  webSearchMaxUsesHint: '辅助模型在一次 Messages 请求内最多可执行的搜索次数，仅适用于 Messages API。',
}
