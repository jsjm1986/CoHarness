---
kind: upgrade-guide
description: "新 Gateway 发布要求具备本地监督程序和已验证的 Runtime 依赖摘要。"
---

# 升级 Gateway Runtime 发布指纹

[English](guide.md) | 中文

## 变化

Gateway 启动指纹采用 CLI 和 Web 已解析的运行时包文件及依赖链接。生产构建把摘要记录在 `gateway/lib/runtime-dependencies.json` 中。macOS 激活在切换选定版本前检查 `gateway/deploy/required-release-files.txt` 并验证摘要。使用旧格式指纹的 Runtime 继续受监督，待兼容重启后接受新转发。

## 迁移

1. 用 `pnpm run build:production` 构建候选版本。暂存完整发布目录，包括 `gateway/lib/local-runtime-supervisor.js`、记录的依赖摘要和已安装的包链接。
2. 通过所属 Gateway 的 Runtime 控制，在安全时点停止仍保留的代次。确认进程退出前保留其发布目录，并核对各已停止代次的 Session 落盘结果。
3. 按[macOS 激活流程](../../../../gateway/deploy/README.zh.md)激活暂存版本，然后启动一个受管 Runtime，确认它在新版本上就绪。
