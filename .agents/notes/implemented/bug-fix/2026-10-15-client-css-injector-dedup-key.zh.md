# Agent Note：客户端 CSS 注入去重键携带 src 相对路径

Status: implemented

[English](2026-10-15-client-css-injector-dedup-key.md) | 中文

## 问题

`packages/client/tsdown.client.ts` 的 `styleInjectionModule` 用 `${packageId}/${basename(file)}` 为每个 `<style>` 标签去重。同一包内不同目录下的同名样式表因此共享去重键：先求值的模块注入规则，第二个文件的规则被静默丢弃——类名照常落到元素上，但元素按浏览器默认样式渲染。`ui-tool` 正好踩中：`tool/ToolDetails.module.css` 输给了 `tool/components/ToolDetails.module.css`，`.code` 输出 `<pre>` 失去 `pre-wrap` 与 padding（退回 `white-space: pre`），在 390px 视口下把右侧详情面板撑到 750px 以上。

## 决策

去重键改为 `${packageId}/${最后一个 /src/ 标记之后的路径}`，`src/` 之外的文件退回 basename。键保持包级作用域与确定性：同名兄弟文件产出不同标签，而同一文件打进多个包时仍按包各注入一次，语义不变。

## 备选方案

**重命名其中一个碰撞文件。** 只能修这一处，静默丢弃的机制仍然埋着，等待下一对同名文件；去重键由 bundler 生成，修复点就应在 bundler。

**去掉去重、每次注入。** 共享模块样式会在每个 importer 处重复落一份相同规则；检查本身是对的，只是键太弱。

## 后果

`ui-tool` 的两份详情样式表现在都会注入；长工具输出在详情面板内换行，不再撑宽面板。未来 `src/` 下任何同名文件自动获得不同键，无需作者知情。嵌套文件的既有 tagId 会变——它们是诊断属性，不是兼容面。

## 验证

`scripts/client-bundle-css.spec.ts` 新增用例：不同 `src/` 目录下两个同名 `Fixture.module.css` 必须产出不同 tagId。装配应用的运行时探针：`pre.IiKC8q_code` 计算值为 `white-space: pre-wrap`，`scrollWidth` 与 357px 盒宽一致，注入的 `data-plugin-css` 标签列表同时出现 `ui-tool` 的两个 ToolDetails 路径。
