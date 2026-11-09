# Agent Note: PostgreSQL 维护的私密输入

Status: implemented

[English](2026-11-04-private-postgres-maintenance-input.md) | 中文

## Problem

将带密码的数据库 URL 放入 `pg_dump` 或 `psql` 参数，会使进程参数检查暴露密码。直接把 URI 密码移到 PGPASSWORD 会改变服务文件的优先级。密码文件不能表示 libpq 接受的所有密码，包括换行；任意 Docker 或 SSH 执行主机也无法读取 Gateway 本机文件。

## Decision

维护命令使用有长度上限的私密 stdin 帧和原生 libpq 适配器。本机直接客户端通过 argv 接收已验证、去掉密码与服务选择器的解析选项，并通过明确的子进程环境接收确切选定的密码。POSIX 包装命令在客户端执行主机上读取该帧，确认 nonce，再将自身替换为客户端。Gateway 只在收到确认后放行恢复 SQL，并从归档字节中移除确认。离线归档读取不携带连接输入。自动 SQL 客户端配对识别不区分大小写的 Windows 可执行文件名，同时仍要求归档客户端唯一。[客户端参考](../../../../gateway/deploy/postgres/README.zh.md#private-maintenance-connections)负责安装与协议说明。

部署连接负责包括默认值在内的目标选择；固定客户端参数不补充缺失的连接字段。Libpq 会启动并关闭一个辅助连接，以解析服务与环境设置。就绪等待使用经过验证的可配置期限。取消会等待本机载体退出；既有的确切后端 lease 与独立 SQL 事务锁继续限制脱离载体的远端恢复。[子进程环境过滤](2026-10-31-postgres-command-environment.zh.md)仍是独立策略。

## Alternatives considered

**通过 PGDATABASE 传完整 URI。** 原生客户端可能将其作为数据库名，而不展开为连接输入。

**去掉 URI 密码并设置 PGPASSWORD。** 服务密码可能覆盖原本显式指定的 URI 凭据。

**使用临时 pgpass 文件。** 其中不能编码包含 LF 的有效密码，本机文件也不能建立远端执行主机可用的路径。

**在 JavaScript 中解析连接 URL。** 这会重复实现 libpq 的关键字、服务、多主机解析与优先级。

## Consequences

维护执行主机需要针对其 PostgreSQL 客户端安装构建适配器。旧包装命令必须采用带版本的 stdin 协议；普通 Gateway 和节点代理构建不要求 C 工具链。获准检查子进程环境的权限主体仍可读取密码。所述保证针对 argv 中的数据库密码，不认证 TLS 私钥秘密，也不对操作系统管理员提供保密保证。在额外私密凭据通道可用前，解析出的非空 TLS 密钥密码、OAuth 客户端秘密与 SCRAM 密钥会被拒绝，不能展开到 argv 中。物理 Windows 维护验收独立于 POSIX 证据。

## Verification

无密钥命令回放检查真实子进程管道。真实可丢弃 PostgreSQL 事务覆盖本机与 Docker 备份／恢复、lease 丢失及多行 Unicode 密码。原生认证观察对照服务、密码文件、空密码、重复值、关键字和多主机场景，并检查实际客户端 PID。定向非法输入检查在不回显连接字节的情况下拒绝执行。
