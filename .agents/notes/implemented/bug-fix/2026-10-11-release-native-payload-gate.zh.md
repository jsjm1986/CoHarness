# Agent Note：Release 激活要求宿主原生 addon 载荷

状态：已实现

[English](2026-10-11-release-native-payload-gate.md) | 中文

## 问题

`validate_release` 枚举了编译 Gateway、Web、Admin、插件与库载荷，但没有覆盖 `native/system` 的构建产物。flock 绑定 `bin/system.node` 与 Landlock launcher 都被 gitignore，因此用 `git archive` 加选择性复制装配的 release 会悄悄缺件。`flock.js` 只在首次获取锁时才懒加载平台包，所以这样的 release 能通过激活、`/healthz` 报告健康，直到第一次会话加锁才失败——对所有走 flock 的路径表现为 `resume failed for session "…": Cannot find module '…/bin/system.node'`，Agent Team 的 resume 也在其中。

## 决策

对呈现完整编译载荷的 release,`validate_release` 要求宿主平台的原生产物就位:macOS 为 `darwin-<arch>/bin/system.node`,Linux 为 `linux-<arch>/bin/{landlock-run,glibc/system.node,musl/system.node}`，按 `uname -s`/`-m` 解析，与 `flock.js` 解析平台包的方式一致。检查放在编译载荷分支内，因此早于 addon 存在的纯源码旧 release 仍可作为回滚目标。`deploy/README.md` 在 release 复制清单中列上了 `native/system/`。

## 已考虑的替代方案

**要求所有平台包的二进制齐备。** 否决：单一宿主构建的 release 合法地只带宿主 addon，其他平台由 CI 原生构建。

**校验整个 `native/system` 树。** 否决：闸门只镜像 `flock.js` 与 launcher 实际解析的路径；entry 的 JS 已由编译载荷检查覆盖。

**在 `validate_release` 顶部对所有 release 执行该检查。** 否决：那会拒绝 `run_gateway` 特意保留可重启的纯源码旧 release，破坏文档化的回滚通道而不提升安全性——那些 release 本就不加载 addon。

## 影响

缺宿主 addon 的编译 release 在 `current` 切换前被拒并给出缺失路径，旧 release 继续服务；`activate` 与 launchd `run` 两条路径都受闸门约束。事故根因——只复制源码、漏掉 gitignore 构建产物的装配流程——现在在闸门处被拦下，而不是在第一次会话加锁时爆发。

## 验证

`macos-release-control.spec` 在编译 fixture 中生成宿主平台原生产物，并断言缺 addon 的 release 在 `current` 切换前被拒；旧版回滚用例在无产物时仍通过。真实宿主上，对缺 `bin/system.node` 的 release 执行 `activate` 会以缺失路径失败且 `current` 不变，而已部署 release 的 `tryLockExclusive` 能通过拷入的绑定完成加锁与释放。

## 相关

- [Release 校验要求 session-format 载荷](2026-09-17-release-session-format-payload.zh.md)——同一清单缺口的工作区包先例。
- [Atomic macOS Gateway releases](../process/2026-08-18-atomic-macos-gateway-releases.zh.md)——本闸门守护的激活顺序。
