---
kind: upgrade-guide
description: "Web 运行时销毁会取消并等待其短生命周期浏览器交接助手。"
---

# Web 交接助手清理跟随其所有者

[English](guide.md) | 中文

## 变化

卸载 Web 运行时的注入连接所有者时，会取消其短生命周期浏览器交接 Node 助手，并等待原生关闭。助手报错后也继续等待关闭。主动取消不产生浏览器失败警告；真实打开失败保留手动 URL 回退。

## 迁移

重新构建 Web 组合包及其匹配应用。自定义使用已导出原生测试钩子的调用方，必须给 `internals.openBrowser(url, signal)` 传入 `AbortSignal`。CLI flag、配置和存储数据保持兼容。平台交接仍由维护中的 opener 负责，交接后的浏览器保留独立生命周期。参见 [Web 组合包参考](../../../../packages/bundle/web-app/README.zh.md)。
