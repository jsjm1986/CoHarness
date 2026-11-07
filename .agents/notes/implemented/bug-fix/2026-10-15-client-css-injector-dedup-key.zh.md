# Agent Note：客户端 CSS 注入去重键携带 src 相对路径

Status: implemented

[English](2026-10-15-client-css-injector-dedup-key.md) | 中文

## 问题

`packages/client/tsdown.client.ts` 的 `styleInjectionModule` 用 `${packageId}/${basename(file)}` 为每个 `<style>` 标签去重。同一包内不同目录下的同名样式表因此共享去重键：先求值的模块注入规则，第二个文件的规则被静默丢弃——类名照常落到元素上，但元素按浏览器默认样式渲染。`ui-tool` 正好踩中：`tool/ToolDetails.module.css` 输给了 `tool/components/ToolDetails.module.css`，`.code` 输出 `<pre>` 失去 `pre-wrap` 与 padding（退回 `white-space: pre`），在 390px 视口下把右侧详情面板撑到 750px 以上。

LightningCSS 还会依据传入文件名生成 CSS Modules 作用域。绝对检出路径让相同源码树产出不同类名，并让内容本应不变的惰性 bundle 在发布目录变动时失效。核查的三个发布版本具有相同 PDF 样式表源码，但各自 2,222,385 字节的 PDF chunk 之间有 37 处作用域前缀替换。

## 决策

统一的样式表标识是 `${packageId}/${最后一个 /src/ 标记之后的路径}`，分隔符统一为正斜杠，`src/` 之外使用文件名。它同时作为去重键和 LightningCSS 文件名。读取文件、虚拟模块 id 和监听依赖继续使用物理路径。不同包和同名源码目录保持隔离；独立私有检出根目录中的相同源码产出相同类名映射与注入器。

## 备选方案

**重命名其中一个碰撞文件。** 只能修这一处，静默丢弃的机制仍然埋着，等待下一对同名文件；去重键由 bundler 生成，修复点就应在 bundler。

**去掉去重、每次注入。** 共享模块样式会在每个 importer 处重复落一份相同规则；检查本身是对的，只是键太弱。

**CSS Modules 仅使用相对文件名。** 能消除检出目录的影响，但不同包内相同源码路径会得到相同作用域。包级标识在保持隔离的同时，不引入机器相关输入。

## 后果

`ui-tool` 的两份详情样式表都会注入，长工具输出在详情面板内换行。相同源码不会仅因发布目录不同而获得不同 CSS 作用域。类名和诊断标签 id 是构建产物；源码编辑仍会改变输出样式。这一机制不负责让惰性资源 URL 独立于其所属包版本。

## 验证

`scripts/client-bundle-css.spec.ts` 运行真实编译插件：独立根目录中的相同源码路径产出相同模块，不同包和源码目录的作用域互异，编辑源码会改变输出，并保留物理监听依赖。针对使用绝对文件名的实现，跨根目录相等与包隔离用例失败，其余五个用例通过。浏览器耗时和 Word 转换总耗时单独测量。
