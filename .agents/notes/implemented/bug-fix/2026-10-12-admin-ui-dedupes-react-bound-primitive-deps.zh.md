# Agent Note: admin-ui 为共享原语引入的每个 React 绑定包做去重

Status: implemented

[English](2026-10-12-admin-ui-dedupes-react-bound-primitive-deps.md) | 中文

## Problem

`gateway/admin-ui` 是独立的 npm 项目，它把 `@deepseek-ai/dsh-client-ui-primitives` 别名到本地源码，而本地源码又转发了真实工作区的图标模块。当共享图标表改用 `lucide-react` 导入后，Vite 把这个说明符解析到根 pnpm store，而 admin 应用自己的 `lucide-react@1.31` 来自它自己的 npm 树。两份 lucide 意味着两个 React 实例：每次图标渲染都调入错误的 React context，整个 admin 测试套件以 `Cannot read properties of null (reading 'useContext')` 全灭。这个失败只在本分支的 CI 上浮现，因为 master 跳过了 admin-ui 任务。

## Decision

`gateway/admin-ui/vite.config.ts` 的 `resolve.dedupe` 现在把 `lucide-react` 与 `react`、`react-dom` 并列，admin `package.json` 的范围也升到 `^1.55.0`，使声明的依赖树真正覆盖共享图标表用到的全部字形。

这是 admin 应用的常设规则：凡是它别名的共享原语引入的 React 绑定包——hooks 载体、context 提供者、组件库——都必须在这里 dedupe，并保持范围满足真实调用点。一个在工作区里能跑的裸导入，一旦出现第二份拷贝，就会在 admin 应用里静默崩坏。

## Alternatives considered

**把 `lucide-react` 别名到单一 store 路径。** 在 `resolve.alias` 里钉死一个文件系统拷贝在 store 布局变化前都有效；`dedupe` 表达的是意图——单一模块实例——并且能经受依赖位置变动。

**把图标字形 vendor 进 admin 应用。** 这个别名存在的意义就是复用共享原语；复制一份图标表会重新打开共享表已经关闭的分叉。

## Consequences

admin 套件重新在单一 React context 下渲染共享图标。今后共享原语再引入任何 React 绑定导入，都适用同样的 dedupe 加范围对齐处理；admin 测试出现 `useContext` 空指针崩溃就是信号。

## Verification

`npm test --prefix gateway/admin-ui`——32 个文件、408 个测试——在共享图标表解析到 admin 应用单一 lucide 拷贝后全部通过。

## Related

[共享动效标尺与字义图标语法](../feature/2026-10-12-shared-motion-scale-and-literal-glyph-grammar.zh.md) 引入了这套拓扑现在承载的 lucide 导入。
