---
kind: upgrade-guide
description: PostgreSQL 维护客户端需要原生私密输入适配器，不再通过连接参数携带密码。
---
# PostgreSQL 维护连接输入

[English](guide.md) | 中文

## 变更

Gateway 备份与 `pg:deploy` 通过私密 stdin 传递数据库连接。直接使用的 `pg_dump` 与 `psql` 需要原生本机解析器；自定义 Docker 或 SSH 包装命令需要在执行主机上安装适配器。接收 `--dbname <URL>` 的旧包装命令不兼容。内置适配器也拒绝非空 TLS 密钥密码、OAuth 客户端秘密及 SCRAM 密钥，这些字段需要独立的私密凭据通道。部署连接解析全部目标设置与默认值，固定客户端参数不能补充缺失的连接字段。

## 迁移

1. 在每台维护执行主机上安装 PostgreSQL 客户端安装所对应的 libpq 头文件、开发库及 C 编译器。Gateway 依赖构建完成后，在 `gateway/` 中运行 `npm run build:pg-client -- --pg-config /path/to/postgres/bin/pg_config`。普通 Gateway 和节点代理构建不要求这个可选维护组件。
2. 保留本机直接客户端命令，或通过 `HGW_PG_CONNECTION_COMMAND` 指定自定义本机解析器。将主机、端口、账户及数据库选择写入部署连接值。默认 `30000` ms 解析／就绪等待不足时，可设置 `HGW_PG_CONNECTION_TIMEOUT_MS`。
3. 在 Docker 内或 SSH 主机上，将适配器与对应 PostgreSQL 客户端一起安装。在 `pg_dump`、`pg_restore` 以及显式 `HGW_PSQL_COMMAND` 客户端之前插入适配器可执行文件；保持 stdin／stdout 为二进制，并禁用伪终端。准确的分帧、环境转发和配对方式见[客户端参考](../../../../gateway/deploy/postgres/README.zh.md#private-maintenance-connections)。
4. 确认适配器带 `--protocol-version` 时输出 `hgw-pg-client/1`。在可丢弃部署中创建并验证备份，完成协调恢复。检查实际客户端参数，确认其中没有数据库密码；确认取消后，目标在 SQL 和文件协调完成前仍被限制写入。
