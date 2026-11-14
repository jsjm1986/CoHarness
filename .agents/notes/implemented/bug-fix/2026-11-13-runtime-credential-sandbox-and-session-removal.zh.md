# Agent Note: 对受限命令隐藏服务凭据，并要求 Runtime 会话删除具备管理权限

Status: implemented

[English](2026-11-13-runtime-credential-sandbox-and-session-removal.md) | 中文

## Problem

由 systemd 启动的 Runtime 通过 `LoadCredential=`(`DSH_GATEWAY_CREDENTIAL_FILE=%d/dsh-gateway`）读取其网关 API bearer 令牌。bwrap profile 以只读方式挂载 `/`，Landlock profile 对 `/` 授予读权限，因此以同一账户运行的模型 shell 命令可以读取 `/run/credentials/<unit>/dsh-gateway`；`$CREDENTIALS_DIRECTORY` 也会进入命令环境。持有该令牌后，`/internal/runtime/session/remove` 无需网关签名的身份断言即可删除 Runtime 范围内任意会话树，包括其他成员的私有会话。

## Decision

[profiles.ts](../../../../packages/sandbox/sandbox-local/src/profiles.ts) 通过 `hiddenCredentialRoots()` 计算需要隐藏的目录（已存在的 `/run/credentials` 与 `$CREDENTIALS_DIRECTORY`）。bwrap 在每个目录上挂载空 tmpfs；Landlock 授权无法相减，因此把对 `/` 的读授权替换为隐藏目录每一级祖先的同级路径。`scrubbedParentEnv()` 删除 `CREDENTIALS_DIRECTORY`。对于项目 Runtime，`/internal/runtime/session/remove` 要求当前身份断言且 `collaboration.access(..., 'manage').canManage` 为真；`GatewaySessionPersistence.remove` 转发请求身份。

## Alternatives considered

**仅通过文件描述符下发凭据。** 暂缓：继承的描述符会传给受限子进程，除非每次 spawn 都关闭它，这是更大的生命周期改动；目录隐藏对两种下发方式都生效。

**对所有 Runtime 会话路由要求身份。** 暂缓：Runtime 持久化可能在请求身份作用域之外调用 load、list 与 append，此时带 `principal: true` 的 `GatewayRuntime.request` 会抛出 `Gateway request principal is unavailable`，逐路由要求身份需要单独的服务身份设计。

## Consequences

在 systemd 主机上，两种 Linux 运行器下的受限 shell 命令只能看到空的凭据目录。Landlock 授权无法排除子树，因此当 Runtime 持有 `$CREDENTIALS_DIRECTORY` 时，其 Landlock 受限命令无法列出 `/` 或 `/run`；对其他路径的读取不变，没有凭据目录的进程仍保留 `/` 授权。通过 Runtime API 删除项目会话时，若转发的成员不能管理该会话，则返回 `forbidden`。个人 Runtime 的删除保留现有的创建者范围检查。仅凭 bearer 的读取与追加仍受 `belongsToRuntime` 约束；对受限命令隐藏令牌是这些路由的控制措施。

## Verification

`local.spec.ts` 断言 bwrap 的 tmpfs 参数、不含隐藏目录及其祖先的 Landlock 读允许列表，以及 `hiddenCredentialRoots` 的规范化。`runtime-api.spec.ts` 断言无断言的删除与非管理者的删除返回 403 且不调用 `removeTree`，管理者可删除会话树。
