# 项目所在电脑的 PostgreSQL 存储

[English](README.md) | 中文

组织 PostgreSQL 库保存账号、访问策略、Runtime 归属和模型计费数据。专用内容库可将项目的对话正文、私有对话参与者、问答结果、执行凭据、输入草稿和工作区目录保存在项目所在电脑。初始化会准备内容卷，已有项目继续使用各自记录的存储位置。

个人工作区目录与兼容空间的对话草稿共用 Gateway 的一个文件进程，首次本地读写时才启动。状态目录须位于本机挂载、受账号权限保护的卷上。已有 SQLite 数据库、日志及其辅助文件必须保持私有，且没有符号链接或硬链接。Windows 使用固定 NTFS 或 ReFS 卷，仅向所属服务账号、SYSTEM 或本地管理员授予访问权限。

## 初始化内容卷

在项目所在电脑的 PostgreSQL 17 默认表空间内新建空数据库。主电脑承载项目时也需要单独的内容库。允许 Gateway 应用角色连接该数据库。使用独立的初始化角色安装 `pg_trgm`、读取 PGDATA 中固定目录的挑战文件并核验 PostgreSQL 集群标识。生产环境应将应用角色和数据库所有者分开。

在 PGDATA 内创建 `harness-node-content-proofs` 目录。Gateway 账号需要能够在其中创建和删除挑战文件、读取 `global/pg_control`，并检查关系文件和 WAL 目录。PostgreSQL 需要能够读取挑战文件。可使用服务专属用户组或操作系统的私有 ACL 授权。PGDATA、数据库关系和 WAL 均须保存在本机存储上。

将 `HGW_NODE_CONTENT_DATABASE_URL_FILE` 设为应用数据库连接地址私有文件的绝对路径，将 `HGW_NODE_CONTENT_VOLUME_ID` 设为稳定的 UUID，将 `HGW_NODE_CONTENT_PGDATA` 设为宿主机可见的数据目录绝对路径。初始化时通过 `HGW_NODE_CONTENT_MIGRATION_URL_FILE` 指定数据库所有者的连接地址私有文件。Gateway 使用现有组织数据库连接、组织标识和节点名定位管理记录。

完成组织库迁移后，在仓库根目录运行已构建的 Gateway 命令。

```sh
node gateway/lib/node-content-provision-main.js
```

成功后会显示节点 ID、卷 ID 和已安装的节点库版本。命令在 PGDATA 下创建随机文件，验证所连接的 PostgreSQL 进程能够读取它，核对数据库与集群身份，并确认文件位于支持的本地文件系统。每个新的数据库连接首次处理项目内容前都会再次完成挑战。

## 项目归属与迁移

已发布的项目必须匹配登记的节点、卷、Runtime 和写入代次。内容库缺失、身份不匹配或表结构不受支持时，受影响的项目会显示不可用。使用其他存储的账号和项目仍可工作。

发布检查要求每类项目内容都有已安装的存储适配器。缺少适配器的部署继续按原存储方式创建项目。已有项目可在继续写入时后台复制。迁移会校验已持久化的字节和按数据库类型读回的行。发布前，原 Runtime 必须已经停止，当前进程代次必须有监督器确认的停机凭据，来源修订号也必须匹配。来源出现新写入后，需要重新获取快照。

原数据库仍保存历史内容时，迁移项目会保留 `retiring` 状态。按照组织保留策略完成原数据退役后，才可以标记为物理隔离。卷验证和准备阶段的复制成功均属于前置条件。

## 在 Linux 上备份运行中的项目文件

Linux 项目电脑配有独立本地 Btrfs 卷时，异机备份可以包含运行中项目的文件。将项目工作区、Runtime 存储和 UserDoc 的两个私有目录放在同一个源子卷中。在同一文件系统、源子卷之外准备仅供 Gateway 访问的快照目录。以普通账号运行 Gateway 时，挂载选项应包含 `user_subvol_rm_allowed`。在该电脑执行 `node gateway/scripts/build-btrfs-witness.mjs` 编译内核探针，并保护发行目录免受 Runtime 账号修改。

将 `HGW_PEER_PROJECT_SNAPSHOTS_FILE` 设为仅文件所有者可访问的 JSON 文件的规范绝对路径。文件包含 `version: 1`、`organizationId`、`nodeId`、`provider: "btrfs"` 和 `projects` 数组。数组每项给出内部项目 UUID `projectId`、源子卷绝对路径 `subvolume` 和快照目录绝对路径 `snapshotDirectory`。后台进程导出获准的项目目录，核验数据库和 UserDoc 水位后释放专用文件快照。备份进程异常退出后，同一 PID 命名空间中的后续备份会核对原进程身份、源文件系统、父子卷和快照 UUID，再回收遗留快照。嵌套文件系统、插件未登记的文件或缺少快照能力都会阻止生成完整恢复点。退役原备份前请核对各策略的实际覆盖情况。

## 在 Windows 上备份运行中的项目文件

Windows 项目电脑使用独立的本地固定 NTFS 数据卷。在同一份快照配置中将 `provider` 设为 `"vss"`。每个项目填入 `projectId`、项目数据子树的规范路径 `source`、原卷 GUID `volume` 及位于子树之外的 Gateway 私有目录 `snapshotDirectory`。可用 `Get-Volume` 查询卷 GUID。所选子树应包含工作区、Runtime 存储和两个 UserDoc 私有目录。`commandTimeoutMs` 指定本机检查卷和创建卷影副本的时限。

Gateway 服务账号需要运行 DiskShadow 和访问本机卷影复制服务的权限。Gateway 核对原卷 GUID、文件系统及启动盘和系统盘标志，复制期间持有临时只读卷影。受保护的路径会检查重解析点、命名数据流和条目数量上限。有路径被拒绝或快照服务不可用时，不能生成完整恢复点。正常完成时，Gateway 释放卷影并确认它已消失。备份进程被强制终止后，下一次使用同一快照目录的备份会核对已登记的进程和卷身份，回收上一次遗留的卷影。

## 检查 Mac 项目数据卷

在项目所在的 Mac 上运行 `node gateway/scripts/check-apfs-project-volume.mjs`，列出已挂载、可写、由本机物理磁盘承载且无系统角色的 APFS 数据卷。挂载项目卷后，向同一命令依次传入挂载点的规范路径、卷 UUID、项目工作区、Runtime 存储及 UserDoc 私有目录。命令核对卷角色、物理磁盘、快照目录清单和各目录的设备号。返回空列表表示尚无符合条件的已挂载卷。

为项目备份策略的 `snapshotExecutable` 配置本机获准使用的快照服务。完成运行中项目的采集，并在指定接收电脑还原验证后，才能将项目文件计入已保护范围。缺少一致的文件快照时，内置项目导出会记录工作区及插件文件的覆盖缺口。

## 验证隔离数据库链路

在已安装 Docker 且本地有 `postgres:17.6-bookworm` 镜像的 POSIX 电脑上运行 `node gateway/tests/run-node-content-postgres.mjs --legacy`。测试会建立独立集群，通过 Runtime HTTP 和本地模拟模型执行请求，并清理临时集群及数据目录。它也会运行原共享存储的项目动态、进度、对话命名空间和执行权限测试。

已构建 Gateway、CLI 和 Web Host 时，`node gateway/tests/run-node-content-postgres.mjs --operations` 会启动两套 Gateway、两套 Web Host、Node Agent、专用治理数据库，以及校验访问密钥的本机模型端点。该用例检查对话准备、浏览器断开后阻止新请求、Runtime 归属和重复提交。可将 `HGW_TEST_PG_BINDIR` 设为本机 PostgreSQL 可执行文件目录以创建独立原生集群。验证结束后，夹具会清理临时集群及其不可变执行回执。

## 组织内项目名

组织内继续沿用原数据库的大小写与排序规则查重。对于已切换到所属电脑的项目，主入口保存带密钥的查重标识及项目、节点和名称版本的标识。显示名称与路径从所属电脑读取。

在指定主入口上，于所有工作区之外建立仅服务账号可访问的目录。下列命令使用该目录的规范绝对路径。第一个参数是可公开的密钥编号，第二个是尚不存在的新文件。命令使用 Gateway 已配置的组织连接，密钥不会输出到终端。

```sh
node gateway/lib/project-name-key-main.js k1 /private/organization-keys/project-names-v1
```

在主入口将 `HGW_PROJECT_NAME_KEY_FILE` 设为该文件。使用已登录的管理员会话访问 `GET /admin/api/deployment/project-names`，然后向其 `/prepare` 接口提交 `{ "keyId": "k1", "expectedRevision": null }`。在每台承载项目的 Gateway 上从 `{ "after": 0 }` 开始调用 `/reindex`，使用返回的游标继续，直至游标为空。在主入口向 `/activate` 提交 `{ "revision": "<当前修订号>" }`。有电脑离线或有项目缺少查重记录时无法启用。历史明文副本按单独的退役清单处理。

轮换时，向同一命令传入第三个参数指向旧密钥文件，在另一个路径生成下一代文件。由组织独立保管可恢复的密钥副本，验证可取回后，再将主入口配置切换到新文件。按当前修订号准备新密钥，在所有项目所属电脑上建立查重记录，最后启用。轮换期间原有密钥继续约束重名。治理库备份中的指纹无法还原密钥。

主入口校验名称时，治理库账号需要能够阻止 SQL 参数值写入日志。数据库管理员可为该账号把 `log_parameter_max_length` 和 `log_parameter_max_length_on_error` 默认值设为零，并关闭已安装的审计或自动执行计划扩展中的参数日志。无法确认这些设置时，Gateway 会先拒绝请求，不会把显示名称提交给数据库做大小写处理。

## 迁移已有项目

在项目所属电脑的管理后台打开「部署」。在「项目内容迁移」中选择项目并检查状态。「准备副本」会核验一致性快照，成员可继续工作。等成员完成工作后再次检查，如源修订已更新，请重新准备副本。Runtime 已停止、所属电脑在线且提示中的检查通过后，方可切换存储。Gateway 提交时会重新核验进程代次。有历史副本保留时，迁移状态为 `retiring`。

使用命令行时，把 `HGW_ADMIN_SESSION_COOKIE_FILE` 设为一份仅属主可读的私有文件绝对路径，文件仅保存该 Gateway 的 `hgw_session=<session>`。使用该会话对应的 HTTPS 地址发送请求。后两条命令要求提供先前核对的同一电脑和项目的预检结果。

```sh
node gateway/lib/node-content-migration-cli.js preflight "$GATEWAY_ORIGIN" "$NODE_ID" "$PROJECT_NUMBER" > project-check.json
node gateway/lib/node-content-migration-cli.js prepare "$GATEWAY_ORIGIN" "$NODE_ID" "$PROJECT_NUMBER" project-check.json > prepared.json
node gateway/lib/node-content-migration-cli.js publish "$GATEWAY_ORIGIN" "$NODE_ID" "$PROJECT_NUMBER" prepared.json
```

## 核验项目插件

受管文件清单记录已观测到的路径。允许自开发插件用于已分库存储的项目之前，请审查完整独立发行包、依赖和所有持久化路径。将发行包装入运维方保护的目录，并作为 Runtime profile 声明的软件包连接。Runtime 系统账号需要有权读取发行包。审批文件和可选核验程序仅供 Gateway 运维方读取。将该 Gateway 的 `HGW_NODE_PLUGIN_PROOFS_FILE` 设为审批文件的规范绝对路径。

`{ "version": 1, "plugins": [...] }` 中的每条记录包含 `owner`（包名）、`releaseDirectory`、`releaseSha256`、`configurations`（已审查的 SHA-256）和 `storage`（`runtime-storage`、`workspace` 或两者）。`nodePluginReleaseDigest` 对安装目录中的完整文件树计算指纹。`configurations` 的输入是与该插件匹配的 profile 和 home patch 层按核验顺序组成的 UTF-8 JSON 数组。没有相关覆盖的插件使用 `SHA-256("[]")`。动态表达式或超出项目允许根目录的存储需要另行核验。发行包或配置变动后需重新审查。

可选的 `verifier` 指定规范的私有 `file` 及 `sha256`。WebAssembly 模块仅可导入 `proof.memory`，不得导入宿主函数或声明内部内存或表。导出 `verify(offset, byteLength)`，返回整数 `1` 表示接受该 UTF-8 JSON 证据。输入包含发行包指纹、适用配置、选定存储种类及已观测的相对路径。Gateway 独立核验 profile 实际选中的包、物理根目录和哈希，在启动及热更新生效前复核。

## 退役历史来源

迁移会切换现役写入位置。清除旧介质需单独遵循组织批准的保留策略。在管理后台查看项目退役报告，其中列出已知仍有数据的关系以及尚待核验的存储范围。使用当前 Runtime、写入代次和已批准保留策略的 SHA-256 发起核验。Gateway 会在项目所属卷核对全部 11 个迁移域的回执，并记录原 PostgreSQL 集群、源快照及当前登记的备份清单。早于原集群身份登记的历史迁移需要独立核对。

六个核验范围分别为保留策略、备份、WAL 归档、副本、原集群介质及其他衍生存储。同一位管理员或同一个存储保管系统可用各范围的专用凭据负责多项核验。各责任方独立盘点其管辖介质，按已批准策略完成处置，然后用 Ed25519 签署核验记录。签名原文包含除 `openedAt` 以外的完整核验挑战，以及 `version`、`domain`、与该存储范围匹配的 `method`、`result`（`verified-clear`）、`inventoryDigest`、`evidenceDigest`、`resourceCount` 和 `verifiedAt`。签名针对原始 UTF-8 字节。详细介质清单留在责任方独立保管的位置。

分别创建 PostgreSQL `LOGIN`，使用 `hgw_retire_policy`、`hgw_retire_backups`、`hgw_retire_wal`、`hgw_retire_replicas`、`hgw_retire_cluster_media` 或 `hgw_retire_other_projections`。这些账号需要 schema 使用权、`project_source_retirement_reviews`、`project_content_placement`、`project_source_retirement_evidence` 的读取权，以及 `project_source_retirement_evidence` 的插入权。私有数据库 URL 单独保存在 Gateway 凭据目录之外。责任方在自己控制的环境将 `HGW_SOURCE_CUSTODY_DATABASE_URL_FILE` 设为该私有文件。命令接收仅属主可读的公钥声明（`domain`、`publicKey`）以及含 `version: 1`、base64 `payload` 和 base64 `signature` 的签名数据包。

```sh
node gateway/lib/node-content-retirement-main.js /private/custodian/trust.json /private/custodian/verified-inventory.json
```

完成提交会重新核验当前放置、已知业务数据、历史归属不明的记录以及登记的备份清单。现役治理库必须已经迁离原明文集群，原集群及其副本均需具备独立的清理证明。仅删行、执行 vacuum、切换逻辑卷、失联或仍有备份留存时，项目保持 `retiring`。此命令导入核验证据，介质处置由对应责任方按照批准的策略单独执行。
