# Agent Note：远程桌面画布跨互操作模式解包内置 noVNC 默认导出

状态：已实现

[English](2026-10-20-remote-desktop-novnc-cjs-interop.md) | 中文

## 问题

发布版客户端 bundle 中 `new RFB(...)` 抛出 `import_rfb.default is not a constructor`，远程桌面标签页在拿到授权的瞬间就使所属 slot 崩溃：签发的 attach token 从未被任何 WebSocket 消费，恰好在 `attachTokenTtlMs` 之后过期——与 runtime 钉住修复所要消除的 `attach`/`detach` 六十秒签名完全一致。

根因在源码之下一层。`@novnc/novnc@1.5` 只发布 Babel 转译的 CommonJS `lib/rfb.js`（`module.exports.default = RFB`）。客户端打包器以 node 模式做 ESM 互操作（`__toESM(exports, 1)`），此时导入绑定的 `default` 是整个 `exports` 对象——类位于更深一层的 `default.default`。源码 `import RFB from` 按打包式 `__esModule` 互操作读取该绑定，产物的属性路径因此完全错过类本身。单元测试看不到这一点：`openScreen` 是注入并被 mock 的，只有部署产物才执行真实导入。

## 决定

`src/client/rfb.ts` 导入模块命名空间一次，解包 `nested.default ?? rfbModule.default`，同时容忍两种互操作形态——直接得到类（bundler 的 `__esModule` 互操作，vitest 下即此形态），或先得到持有类的 exports 对象（部署 combo 的 node 模式 emit）。`index.ts` 消费归一化后的绑定；一个 client spec 断言导出的 `RFB` 是构造器，使该互操作假设可执行。

维持 1.5 的版本钉住：1.6+ 改为 `core/` ES 模块，其顶层 await 无法打进客户端运行时的模块行。

## 备选方案

**把模块声明成 `export =` 并按 `rfbModule.default` 字面消费。** 否决：`export =` 确实贴合部署产物的 node 模式 emit，但在测试运行器的 `__esModule` 互操作下同一表达式得到 `undefined`——能通过评审却在别处失败。运行时必须容忍两种形态，只有解包能做到。

**升级 noVNC 到 ESM 版本。** 否决：版本钉住的存在正是因为更新的包无法打进客户端模块格式；解钉等于用一个局部解包换整个特性的打包失败。

## 影响

标签页的 `openScreen` 重新构造出真实的类，同意 → attach → WebSocket → RFB 握手得以端到端打通，pending-token 过期签名从审计中消失。此后任何客户端导入 Babel 式 `__esModule` CommonJS 包都需要同样的解包或显式互操作核查——部署产物遵循 node 模式语义，而非打包式 `__esModule` 塌缩。

## 验证

`pnpm vitest run packages/client/ui-remote-desktop` 在测试互操作下覆盖该解包；人工核查了部署 `lib/client.js` 的 emit（`import_rfb.default.default`）；并以真实公网站点端到端驱动：同意 → attach → `wss://…/stream?token=…&dshTarget=…` 成功打开，`RFB 003.889` 到达浏览器。
