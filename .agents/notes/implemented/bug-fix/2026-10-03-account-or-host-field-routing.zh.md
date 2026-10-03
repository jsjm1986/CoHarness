# Agent Note：account-or-host 设置作用域按字段白名单路由写入

状态：已实现

[English](2026-10-03-account-or-host-field-routing.md) | 中文

## 问题

`AccountOrHostSettingsScopeController` 把命名空间内的全部字段写入都发往账户偏好端点，但 `PATCH /account/api/preferences` 只接受固定字段白名单（`locale`/`ui-theme` 的 `preference`；`ui-conversation` 的 `busyEnter`、`chatContentWidth`、`chatFullWidth`、`chatFontSize`）。仅由 Host 设置承载的字段（`transcriptView`、`performanceUsage`、`linkOpening`）被 400 `invalid-account-preference` 拒绝；又因同一命名空间的所有行共享该作用域的写状态，一个被拒字段把整个区块染成"保存失败"。读取同样显示账户侧默认值而非 Host 已存值。

## 决定

组合作用域现在按 `ACCOUNT_FIELDS` 路由每次 `set`/`unset`：白名单字段走当前权威源（账户，或 404/501 回退后的 Host），其余字段直接走 Host 作用域。账户层激活期间 Host 订阅保持安装，发布的快照合并两个分区：`value`/`base`/`user` 的白名单键取账户层、其余取 Host 层，`write` 上浮两个写状态中更紧急者（error > blocked > saving > idle）。`ACCOUNT_FIELDS` 放在 `account-scope.ts`，与已硬编码同一 wire 契约的镜像命名空间投影相邻；client bundle 纯度门禁止与 `dsh-client-connection` 共享该常量。

## 文件

- `packages/client/ui-settings/src/client/account-scope.ts` — 字段路由、双订阅、合并快照层。
- `packages/client/ui-settings/src/client/settings-scope.ts` — 向组合作用域传 `spec.namespace`。
- `packages/client/ui-settings/tests/account-scope.client.spec.ts` — 路由与合并回归。

## 影响

`account-or-host` 支撑的设置行把 Host 专属字段写入 Host 设置文档；真实的 Host 写失败仍会以行错误态上浮。向账户端点白名单新增字段需要同时更新 `ACCOUNT_FIELDS`、`AccountPreferenceMutation` 联合与镜像命名空间投影。
