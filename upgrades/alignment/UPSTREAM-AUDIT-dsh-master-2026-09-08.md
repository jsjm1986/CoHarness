# CoHarness 上游持续对齐审查（2026-09-08）

审查基线：CoHarness 当前工作树；上游 `deepseek-harness/master` `c389f96bf3`；上次已同步的 alpha.2 tag `82a5fd61a7`。

## 结论

上游在 alpha.2 之后已经形成一组新的 Workspace 资源协议：`workspace-path`、`fs` 有界字节读取、Host `workspace-files` 双端 API、Client `resources` 注册与订阅，以及 Sidebar 文件树和分页预览。这不是单个 UI 功能，而是跨 Host/Client/远程 Gateway/Session 的协议扩展。CoHarness 当前没有这些包，因此不能直接只拷贝 Sidebar UI；应作为下一阶段独立协议升级。

云端部署继续禁止把服务器路径当作用户本地路径。Workspace 文件协议应返回经过授权的 Session 资源地址和受限字节窗口，不能暴露宿主绝对路径，也不能把 Open in App 默认接到云端。

## 高优先级对齐项

| 优先级 | 上游变化 | CoHarness 状态 | 处理建议 |
|---|---|---|---|
| P0 | `workspace-path`、`fs` bounded byte windows | 缺失 | 先定义远程资源地址、Session 授权、分页读取和变化游标，再接 UI |
| P0 | `workspace-files` Host/Client 双端协议 | 缺失 | 复用 Gateway ACL/CAS；禁止绝对路径出现在 wire 响应 |
| P0 | Client resources retained subscriptions | 缺失 | 与现有双流 mux、冷恢复、Session scope 对接，补断线重订阅 |
| P1 | projection-aware session controller/queue 修复 | 已有 Queue/Activation，但需逐项审查 projection 来源 | 重点检查冷恢复、父子授权、队列镜像是否仍从事实体而非 projection |
| P1 | IPC performance optimization | 未同步 | 在协议稳定后评估批量消息、订阅去重和历史窗口，不能直接替换现有 mux |
| P1 | Sidebar、文件树、分页预览、产物打开 | Workbench 已有产品行为 | 仅移植行为和资源模型，保留 CoHarness Workbench façade |
| P2 | reconnect、scroll、resize、PTY、PowerShell、desktop packaging 修复 | 部分已同步 | 按平台定向验证，不能影响云端默认组合 |

## 明确暂缓

完整 `ui-chat` 替换、Electron/桌面打包、Remote Gateway 控制面、benchmark/CI-only 变化，以及任何要求在云 Host 启动本地应用的路径均暂缓或保持独立版本线。

## 协议风险

1. Workspace 资源必须绑定 Session 和当前连接身份；资源订阅恢复时重新做 ACL 检查。
2. `readBytes` 必须有最大窗口、偏移和不可变快照语义，避免大文件一次性进入 Web 内存。
3. 文件变化 feed 必须可重放并处理游标失效；不能把实时通知当作唯一事实来源。
4. 文件树和预览只能消费资源 API，不能绕过 Gateway 直接读取 Host 文件系统。
5. Deliverable “打开文件”在云端只能打开 Sidebar 资源或生成下载/复制动作；Open in App 仍是桌面 Host 的显式能力。

## 本轮验证

已获取并审计上游 master，确认 alpha.2 之后包含 730 个文件变化、约 43.8k 行新增，核心新增集中在上述 Workspace 资源协议和 Sidebar 组合。当前工作树未执行大规模合并，避免覆盖现有 Workbench 未提交改动。
