# Agent Note: 在申请浏览器资源前判断 Inspector Client 准入

Status: implemented

[English](2026-10-23-inspector-client-origin-admission.md) | 中文

## 问题

可选的 Inspector Host 能同时服务本地与公网 origin 的浏览器页面。Client ingest 直接连接 Worker 的 loopback 地址。其他机器上的浏览器会把该地址解释为自己的电脑；即使浏览器恰好运行在 Host 机器上，公网文档 origin 也不符合 Worker 的默认 origin 规则。把这种不匹配当作临时传输故障，会让 Worker 无法接纳的 Client 持续重连并采集 Cordis 树。

把 bootstrap 与 DevTools 选择逻辑放在同一个运行时模块中，会让 Client 构建器抽出启动入口和异步面板共用的同步分块。页面模块系统只通过异步导入加载包内分块；入口工厂执行时，该共享分块尚不可用，会阻止整个工作台挂载。

## 决策

Host 在 Client bootstrap 中传递其额外允许的 origin。Client 启动与 Worker ingest 复用同一 origin 判断，使浏览器准入先于 source 身份、传输和 collector 资源申请。连接重置会先重新判断准入，再决定是否保留既有 source。Origin 准入只选择可用能力；Worker 监听地址与 token 鉴权仍各自独立负责。[包参考文档](../../../../packages/experimental/inspector/README.zh.md#runtime-layout)拥有配置与生命周期细节，[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/inspector-client-origin/guide.zh.md)拥有自定义 bootstrap 的兼容要求。

不符合条件的页面保留既有的已鉴权、同源 Host 调试转发。其底部面板发送显式的仅 Host 选择参数，而不把仅 Host 检查表示成一个缺席的 Client。共享的选择判断会在 source 目录、realm session、Cordis 查询树和 DOM 投影中排除 Client。该显示范围不授予或撤销调试权限。

Client 启动直接导入 `shared/client-bootstrap.ts`，异步面板直接导入 `shared/source-selection.ts`。Host/Worker 使用的 `shared/web.ts` 聚合导出保留既有调用点，不把两条 Client 运行时依赖重新连接。按运行时用途分离模块保留面板的异步加载，无需引入同步分块加载协议。

[Inspector 移植决策](../feature/2026-10-18-experimental-inspector-port.zh.md)继续拥有可选组合及 fork 的 Session 和线路依赖。Origin 准入约束浏览器工作，不移除开发者工具 bundle，也不引入远程 Client ingest 传输。

## 已考虑的替代方案

**扩大 Worker 监听范围或自动允许公网域名。** 修改 origin 规则不能让浏览器的 loopback 地址指向服务器。扩大监听范围还会暴露直接 CDP 端点；该端点以 loopback 绑定作为访问控制，求值操作能够执行 Host 代码。既有的已鉴权同源 Host 转发已经支持需要保留的 Host 功能，不需要扩大范围。

**从通用 loopback 连接标志推断准入。** 显式配置的本地开发主机名可以被 Worker 允许，却不属于 loopback 主机名。复用 Host 的实际规则能保留这种已支持配置。

**限制重试或隐藏 Inspector 面板。** 重试预算仍会在已知的 origin 拒绝之前申请 source 与 collector，而隐藏面板会移除可用的 Host 检查。提前准入可以消除不支持的 Client 工作，并保留既有 Host 功能。

**省略 Client 选择参数或编造不存在的 Client id。** 省略参数会包含全部 Client，让标为仅 Host 的面板显示无关 Client context。编造的 id 仍是 Client 能够声明的合法 source 身份。显式仅 Host 范围不受 Client 名称或 id 影响，始终排除全部 Client；既有的无过滤与指定 Client 模式保留各自含义。

**内联整个面板或增加同步分块加载。** 内联会把面板依赖放进入口工厂。新增分块协议会扩大模块加载器的职责。拆分运行时模块能沿用现有协议，保留面板的异步加载。

## 验证

[Client 回归](../../../../packages/experimental/inspector/tests/plugin.client.spec.ts)使用生产插件、被拒绝的假 socket、默认 250/5000 ms 退避上界、固定随机值和 15 秒假时钟。不支持 origin 的基线申请一次 source、构造八个 socket、采集三次快照，并保留一个重连定时器；提前准入后四项计数全部为零。Localhost、IPv6 loopback 和显式允许列表对照保留这些计数，dispose 会清除定时器。这些是有界工作量计数，不是墙钟耗时、保留内存或公网测量。

[Worker 集成](../../../../packages/experimental/inspector/tests/integration.host.spec.ts)、[转发覆盖](../../../../packages/experimental/inspector/tests/plugin-routes.host.spec.ts)与[底部面板回归](../../../../packages/experimental/inspector/tests/bottom.client.spec.tsx)验证存在其他 Client 时的仅 Host 检查，包括名称为 Host、source id 为 `host` 的 Client。Origin 规则覆盖还会独立于 token 检查真实 Worker 的接纳与拒绝。这些检查确立准入和选择行为；浏览器输入延迟、资源占用及已部署公网隧道下的仅 Host 交互，需要对版本一致的已构建 Host、Client 和 DevTools 资源另行测量。

[组装 Web 回归](../../../../apps/web/tests/inspector-boot.e2e.ts)通过已构建 Client bundle、真实 Worker 和已鉴权 Host 路由启动可选 profile，再分别在 loopback 与不准入的合成 origin 下打开面板。测试还创建并 flush 真实 Session；在 POSIX 上，plain Node 第二进程调用随产品发布的原生 `flock` 入口，被实时写租约排除。使用合并模块的负控在工作区选择器出现前，因同步 `require("./client.web.js")` 缺失而失败，即使 `host.describe` 已成功。上述隔离检查不覆盖 Gateway 鉴权或已部署隧道。

## 后果

Worker 拒绝的 origin 不提供 Client 观测服务，也不申请 Client source、ingest socket、collector 或传输重试定时器。符合条件的本地开发保留 source 与恢复行为。仅 Host 检查继续通过既有转发提供，而 Host collector、fetch 采集和 Worker 保留历史仍各自承担配置决定的成本。消除不支持的 Client 工作，不代表整个 Inspector 没有成本，也不代表已测得公网页面延迟。
