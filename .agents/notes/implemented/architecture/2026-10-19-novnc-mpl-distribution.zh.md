# Agent Note: 远程桌面客户端的 noVNC MPL-2.0 分发

Status: implemented

[English](2026-10-19-novnc-mpl-distribution.md) | 中文

## 问题

人类远程桌面客户端（`ui-remote-desktop`）需要在浏览器标签页内渲染 RFB（VNC）画面。`@novnc/novnc` 是 OpenStack、Anthropic computer-use demo 和 OpenHands 都在用的成熟实现，但它声明 MPL-2.0，落在 `scripts/gen-third-party-notices.ts` 强制的宽松许可证白名单之外。

## 决策

将 `@novnc/novnc` 作为 `ui-remote-desktop` 的打包运行时依赖出货，原样导入 `core/rfb.js` 模块。MPL-2.0 是文件级弱 copyleft：其义务覆盖 noVNC 自身的源文件，而客户端打包产物构成的大作品仍保持项目许可证，因为没有修改任何 noVNC 文件。`assertRuntimeLicenses` 中的身份级豁免仅按 `@novnc/novnc` 这一包身份在 MPL-2.0 条款下放行；其他包身份或许可证条款变更依然拒绝。

MPL-2.0 §3.2 的源码可得性通过 `THIRD_PARTY_NOTICES.md` 满足：声明文本把接收方指向上游仓库 `https://github.com/novnc/noVNC` 作为打包代码的对应源码。分发的副本是已发布的 npm 包；打包器的压缩不产生新的被覆盖文件。

## 备选方案

**selkies-gstreamer。** 帧率更高，但默认构建启用 GPL 编码器（`PIXELFLUX_ENABLE_GPL=0` 是非默认构建选项），且它用自定义流替换 RFB，会失去 provider 依赖的跨平台 VNC 服务端兼容性。

**iframe 嵌入官方 `vnc.html`。** 避免打包，但引入了无法接入 `packages/client/*` 的槽位、props 与本地化纪律的外部 UI，且分发的仍是同一批 MPL-2.0 代码。

**IronRDP web component。** Apache/MIT 许可的 WASM 客户端，但它是 RDP 实现，macOS 没有对应服务端路径，无法覆盖三系统目标集。

**自写 RFB 客户端。** 完全去掉第三方条款，但等于重实现安全握手、帧缓冲编码与输入消息处理，而 provider 测试已经按 noVNC 的行为钉死了这些协议细节。

## 后果

`THIRD_PARTY_NOTICES.md` 记录身份级 MPL-2.0 豁免与对应源码链接；notices spec 断言提交的字节一致。升级 `@novnc/novnc` 沿用同一豁免；已发布清单中许可证变化会导致 notices 检查失败并需要新决策。仓库不复制 noVNC 源码；接收方对上游仓库行使其权利。
