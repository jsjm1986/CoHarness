# Agent Note：让账号目录及搜索结果独立于慢电脑

Status: implemented

[English](2026-11-16-independent-computer-directory-search.md) | 中文

## 问题

标签页最初的 Runtime 是执行目标，并不拥有组织目录。展示其他已授权电脑前若必须读取该电脑的账号上下文，一台不可用节点就会阻塞导航。将所有已连接 Runtime 的搜索合并为一次最终发布，会让内容结果产生同样的依赖；已有成功结果时，也必须区分其他电脑不可用和确实没有匹配项。

## 决策

[EntryDirectory](../../../../packages/client/runtime/src/client/entry-directory.ts) 从中心的 `/account/api/workbench/context` 获取当前账号、项目成员及精确引导身份。[Gateway](../../../../gateway/src/server.ts) 通过治理数据解析身份并检查入口允许的节点范围，不准备目标 Runtime，也不向它转发。已有的分页 Runtime 授权及节点本地元数据读取保留权限校验。内容属于节点的项目名称与路径在中心目录中保持占位标识。

[SessionRuntimePool](../../../../packages/client/runtime/src/client/sessions/pool.ts) 按已连接 Runtime 分别报告进度。请求内的快照包含带 Runtime 的结果身份及待完成、成功或失败状态；取消或销毁会阻止后续发布。最终 Promise 为不呈现进度的消费方保留合并结果语义。[WorkspaceBrowser](../../../../packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx) 在其他电脑尚未返回或不可用时保留成功结果，并将命中的电脑入口与对话、Workspace 匹配项同时展示。

## 考虑过的替代方案

使用上次成功的引导上下文可以保持导航响应，却可能保留已撤销的授权。读取当前中心治理数据既保留权限检查，也不会把另一台电脑的可用性变成前提。搜索所有登记电脑会扩大用户请求范围并建立不必要的 Runtime 连接；搜索仍限于池中已有的连接。

## 影响

离线执行节点不会阻止中心列出其他已授权目标。它自身的内容仍要求该节点的当前权限检查及可用性；操作不会静默切换到其他电脑。工作台「全部空间」只搜索本标签页已载入且有权访问的对话，更多内容通过明确选择空间后分页读取。目录与搜索不改变草稿、标签页选择、正在运行的任务或定时任务。

## 验证

Gateway 路由测试验证离线引导目录、精确目标与主体拒绝，以及不转发、不启动 Runtime。客户端测试挂起一项搜索，验证另一项先发布，覆盖取消与节点失败，并确保电脑名命中时仍保留对话匹配项。[个人空间浏览器场景](../../../../apps/web/tests/personal-computers.e2e.ts) 使用两个独立 Web Host，在释放另一台电脑的响应之前记录快速返回结果的可见快照。
