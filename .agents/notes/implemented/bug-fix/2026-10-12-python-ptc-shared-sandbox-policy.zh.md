# Agent Note: Python PTC 在共享文件沙箱策略下运行

Status: implemented

[English](2026-10-12-python-ptc-shared-sandbox-policy.md) | 中文

## 问题

`PythonPtcRuntime` 对每个 `request.sandboxPolicy` 都以 "sandbox policy is unsupported" 拒绝，并在不受约束的 `python3` 进程里运行模型程序；而 Node PTC 运行时早已在共享的 `sandbox`/`sandboxPolicy` 服务下执行。`run_code` 工具只对报告 `sandboxMode` 的运行时开放 `sandbox_permissions` 升级参数，因此 Python 程序既不能被约束也不能申请升级——文件副作用只受进程 UID 限制，不受策略限制。

## 决定

把上游 `11a0f85b340` 移植到 CoHarness 包。运行时声明 `inject = ['sandbox', 'sandboxPolicy']`，从策略服务默认模式报告 `sandboxMode`，解析 `request.sandboxPolicy ?? ctx.sandboxPolicy.resolve()`，以 `request.cwd ?? sandboxPolicy.workspaceRoot` 推导 `cwd`，并作为 `ConfinedArgv` 经 `ctx.sandbox` 启动。可信的 `bootstrap.py`/`protocol.py` 源码改为经 `PYTHON_BOOTSTRAP_LOADER`/`bootstrapInput()` 从 stdin 送入解释器，不再做逐次运行的临时目录拷贝，约束不再依赖沙箱可见的暂存文件；`LiveRun` 通过 `AbortController` 结算。执行说明声明直接文件访问遵循本次执行的沙箱策略，这让 `run_code` 能为 Python 运行开放 `sandbox_permissions`/`justification`。

## 备选方案

**继续拒绝 `sandboxPolicy`。** 否决：工具与请求类型早已携带该字段，放任无约束的 Python 执行与 Node 运行时实施的策略相矛盾。

**保留逐次运行的脚本临时拷贝。** 否决：受约束的子进程无法可靠读取宿主临时文件，stdin 加载同时消除了旧注释记录的拷贝竞态。

## 影响

Python 运行现在遵循现行文件策略，并可经与 Node 运行相同的审批路径申请一次性升级；沙箱拒绝经运行的 `sandbox.denied` 字段上报。此变更前录制的会话展示不同的 `run_code` schema；生成式 catalog 与 `ptc-python-turn` 的期望 schema 已记录新的模型可见文本。上游 `ptc-python-read-only` 快照夹具不携带：它按上游 v4 codec 与 `working-directory` 上下文段录制，我们当前 codec 代际两者都不接纳；`sandbox.spec.ts` 在进程内覆盖拒绝路径。

## 验证

`packages/experimental/ptc-runtime-python/tests/` 覆盖受限 argv、策略解析、升级拒绝、协议帧与游离片段处理（325 个测试，2 个按平台跳过）；包 typecheck 干净，`pnpm run test:snapshot` 按重生成的 schema 回放 `ptc-python-turn` 通过。

## 相关

- [DeepSeek 请求扩展容错](2026-10-12-deepseek-request-extension-resilience.zh.md)——同一 alpha.2 对齐批次。
- 上游提交：`11a0f85b340`（Python 执行接入共享沙箱策略）。
