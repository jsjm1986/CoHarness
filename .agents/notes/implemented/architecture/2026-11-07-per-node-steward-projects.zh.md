# Agent Note: 通过 steward_node_id 绑定的每节点 steward 项目

状态：已实现

[English](2026-11-07-per-node-steward-projects.md) | 中文

## 问题

驻地 steward 最初设计为一个组织级单例项目（`projects_steward_singleton`）加每节点挂载。该形态无法在多个节点上承载 steward 运行时：`instances_organization_project_key` 强制每个项目全组织仅一个运行时实例，而 `resolveTarget` 按 `(project public_id, assigned_node_id)` 查找实例。因此在第二节点启用 steward 只落成了挂载，驻地运行时以 `Runtime assignment is missing` 失败。

受管 Linux 节点上还暴露了关联缺陷：`prepareStewardWorktree` 以网关属主（root，0755）创建工作区，而 steward 运行时以共享项目账户（`harness-node-project`）运行，导致运行时自身的工作区拒绝其写入。

## 决策

steward 改为按节点的项目。[迁移](../../../../gateway/deploy/postgres/migrations/124_per_node_steward_projects.sql) 为 `projects` 增加 `steward_node_id`（指向 `compute_nodes` 的外键，CHECK 约束绑定 `kind='steward'`），用 `projects_steward_per_node`（`UNIQUE(organization_id, steward_node_id)`）替换 `projects_steward_singleton`，存量 steward 项目回填其已分配运行时的节点并追加 `·<节点>` 名称后缀，删除节点外的游离挂载。回填已加固三处边缘：无主 steward（无实例、无活跃挂载）归档而非违反绑定 CHECK；组织名称策略存在时跳过重命名，因为 `require_project_name_claims` 会要求迁移无法产出的名称凭据；绑定 CHECK 容忍 `status<>'active'` 的行。

`ensureSteward` 只为本节点播种：`stewardProject()` 按 `p.steward_node_id` 过滤，插入以本节点 id 写入 `steward_node_id`，显示名变为 `<name>·<nodeName>` 以保持组织级名称唯一键可满足。`prepareStewardWorktree` 对工作区执行 `documentRuntimeAccess(runtimeUser, sharedProject=true)`，使受管 Linux 节点获得 `root:<runtime-gid>` 2770 属组写权；非受管主机不做任何调整。

配套两处服务层加固：`recoverSteward` 以复活绑定行回应 `projects_steward_per_node` 冲突（在 `project_mounts_pkey` 上 UPSERT 恢复 `status='active'`；实例行仅在缺失时补插），因为 `insert()` 把 23505 包成普通 `Error`，约束名只存留在消息文本中；steward 插入豁免组织名称策略——[迁移 125](../../../../gateway/deploy/postgres/migrations/125_steward_name_claim_exemption.sql) 令 `require_project_name_claims` 对 `kind='steward'` 提前返回，`insert()` 对保留 kind 跳过 `nameAuthority` 要求，因为各节点播种时没有浏览器操作者，不可能存在主站签发的名称证明。`reindexNames` 仍会在 `activateProjectNameKey` 接纳待定密钥前为 steward 行补凭据，策略覆盖因此保持完整。

## 备选方案

**共享单例项目 + 每节点一个实例。** 需要把 `instances_organization_project_key` 放宽到包含 `assigned_node_id`，等于为所有项目放开多节点运行时——对单写者内容假设和歧义目标解析的爆炸半径大得多。

**中心 steward + 远程执行通道。** 此前已否决：等于在节点通道内重造带审计的远程 shell 语义，只为换取 SSH 带外已提供的便利。

## 影响

各节点 steward 独立获得资格：`steward_access_policies` 保持节点维度（由本网关按自身 `nodeId` 写入），catalog 将每个 steward 项目解析为其宿主节点上的运行时，运行时只携带本节点的工作区、部署树与配置的只读根——按节点的爆炸半径与按节点的撤销。管理员在项目列表中看到每节点一个 steward 项目。

## 验证

- `runtime-management-postgres.spec.ts` 以双节点上下文断言两个绑定项目、活跃挂载与每节点实例分配，覆盖重复播种幂等性与丢挂载后的冲突恢复路径（随套件 13/13 通过）。
- `steward.spec.ts` 与 `steward-worktree-postgres.spec.ts` 保持通过（23 + 1 + 11 个 steward-worktree 用例）。
- 生产：迁移已应用；`维护中枢·mac-mini`（代 256）、`维护中枢·ubuntu-101-36-115-219`（代 2）与 `维护中枢·windows-vps-47`（代 6，端口 42001）均 `ready`；ubuntu steward 通过公网站点执行了真实任务（`hostname` 返回该节点名、工作区文件以 `harness-node-project` 落盘、`/var/log` 只读根可服务），windows steward 经同一公网会话路径完成了 `pwsh` 版 `hostname` 与工作区文件写入。
- Windows 在 `local` 启动器下运行 steward：默认 `harness-project` 运行时用户名可通过 `HGW_STEWARD=on` 启动校验，并仅作为启动元数据记录——本地监督器不创建受限 OS 账号；`HGW_STEWARD_READ_ROOTS` 接受正斜杠路径（`["C:/releases","C:/harness-gateway"]`）。
