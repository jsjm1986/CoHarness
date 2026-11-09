---
kind: upgrade-guide
description: 受托管项目及工作区目录必须是配置父目录的严格子目录，不能使用父目录自身。
---
# 托管工作区的目录包含关系

[English](guide.md) | 中文

## 变更

Gateway 拒绝与数据根目录相等的托管项目目录，以及与受托管根目录相等的工作区，包括规范化后等价的路径。通过空相对路径比较而被接受的配置会在启动时失败。`HGW_PROJECT_PATH_ROOTS` 也会拒绝 Windows 磁盘及共享根目录，并接受不同卷上的独立目录。

## 迁移

1. 对于 systemd 项目目录，将 `HGW_PROJECTS_ROOT` 与 `HGW_USER_PROJECTS_ROOT` 分别放在 `HGW_PROJECT_PATH_ROOTS` 的独立严格子目录中。
2. 启用受托管模式时，通过 `HGW_STEWARD_WORKSPACE` 选择 `HGW_STEWARD_ROOT` 的严格子目录，例如默认 `workspace` 子目录。改变活动路径前，应通过部署的受控数据迁移转移现有数据。
3. 加载最终 Gateway 配置，确认启动接受子目录。选择父目录自身必须在任何 Runtime 启动前失败。既有的保留目录与账户权限检查仍然适用。
4. Windows 应选择 `C:\\project-data` 等数据目录，不能使用 `C:\\` 或共享根目录。独立数据目录可位于不同卷中；嵌套或等价目录仍然无效。
