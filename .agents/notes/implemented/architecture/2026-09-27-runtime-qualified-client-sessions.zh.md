# Agent Note: 带 runtime 限定的 Client Session

Status: implemented

[English](2026-09-27-runtime-qualified-client-sessions.md) | 中文

## Problem

持久 Session ID 在所属 runtime 内标识日志。个人 JSONL 存储和项目 runtime 可以包含相同 ID。浏览器若按首次出现的条目显示摘要，却按最后出现的条目路由操作，就可能显示一个会话并修改另一个会话。在 wire 上为任意字符串加前缀还会破坏消息内容，也无法解决控制器缓存问题。

## Decision

按账号作用域运行的 Client 池将原始 ID 和 runtime 编码为规范浏览器键。其列表、binding、作用域 store、快照、资源地址及 Workbench 记录使用该键。每个 runtime 保留原始 API client 和日志 ID。绑定的 Session 方法继续由其所属 runtime 执行；API 传输层仅解码已声明的 Session 地址字段。生成的 Agent lookup 与应用显式声明的 Remote JSON 路径共用连接选择。请求中的 runtime 地址互相矛盾时，在发送前失败。消息文本、工具 JSON、持久事件和 Host ID 保持不变。

Host 握手在重放或加载列表之前声明启动凭据固定的 runtime。个人目标解析不假定引导连接一定是个人空间。目标回调核验其确切保留条目，已释放 generation 无法修改或撤销替换后的 runtime。失去访问权会撤下目标及其资源。

预设芯片、项目共享、只读输入区和创建准备使用所寻址的 Session 或所请求的 runtime。经 Agent Context 发起的无作用域 Remote 读取使用该 Context 的 runtime。缺少 runtime 地址的旧布局必须经目录验证后才能迁移，不猜测有歧义的引用。持久化与页面生命周期仍由既有账号身份拥有。

浏览器键限定在账号内：认证主体变化会销毁整个保留的 Client generation。Gateway 请求携带页面确认的账号，仅作为拒绝条件；其他账号的 cookie 无法重定向旧窗格的操作。HTTP 身份响应与账号上下文验证共用 Connection 拥有的唯一守卫。它中止待处理请求、拒绝迟到结果、停止 socket 投递、释放 Runtime 资源，并在清理后重载。临时断线会保留同一账号的缓存。

同一守卫独立于浏览器作用域 cookie 固定引导 runtime。原生预览、下载与上传 URL 携带仅用于拒绝的身份选择器。文档草稿使用所寻址窗格的存储；跨 runtime 选择先复制到目标存储，再附加得到的引用。既有账号／runtime／原始 ID 持久化键保留归属，只对内置资源地址执行限定迁移。

Runtime 获取持有覆盖握手、列表加载和目录验证，直到调用方接管后续 Session 引用。Workbench 打开、创建及跨 runtime 恢复共用该操作所有者；空闲清理不能销毁仍在获取中的 runtime。取消和账号失效释放待完成的持有，活动消费者继续由各自 Session 引用拥有。

保存的布局是元数据，不证明 runtime 正在运行。临时连接失败和手动停止响应只保留当前目录授权的身份以供重试。个人目录不完整时保留尚未核实的个人元数据，不宣称 runtime 可达，也不猜测旧 ID 的归属。未核实的旧记录保持只读，不接受其原始 ID 格式无法保存的编辑。明确拒绝或确认不存在会移除保存的窗格，账号变化会撤下视图。后台恢复不会把被动请求升级为显式启动。

## Alternatives considered

拒绝相同原始 ID 会削减已支持的并发窗格。改写 Host ID 或任意 wire 字符串会改变持久数据及无关内容。只为窗格 ID 补充 runtime 仍会让命令、资源和控制器缓存产生歧义，因此消费者共用 Client 键，仅解码已声明的 wire 字段。

固定时间宽限无法证明调用方何时完成 runtime 接管，并会在取消后继续保留无用资源。操作所有权覆盖获取及接管，再交给既有 Session 引用。

## Consequences

多个窗格可持有相同原始 ID，而不共享草稿、历史、待处理操作、文件观察或释放计数。浏览器键不是新的 Host ID，也不迁移 Session 代次。PostgreSQL 项目会话继续遵守既有的组织内 ID 唯一性：此决定支持独立归属的 runtime 日志，不放宽数据库插入约束。

[Session 作用域决定](2026-07-25-web-client-session-scope-and-provide-channel.zh.md)继续拥有确切 generation 生命周期及 effect 释放规则。[资源模型决定](2026-09-05-client-resource-model.zh.md)保留其地址与提供者原理；带 runtime 限定的 Session 部分让地址在池化目标间保持无歧义。两份决定均未被完全取代。

## Verification

Client 池回归同时持有原始 ID 相同的四个独立 runtime，核对实际 API 目标、作用域身份、事件路由及独立释放。API 与 Remote 负例保留内容中的同值字符串，并拒绝混合目标。Workbench 迁移测试拒绝有歧义的裸 ID，同时保留有效布局。浏览器场景执行完整 Web runtime 和模型请求重放；Gateway 路由测试独立证明带项目限定的共享拒绝。
