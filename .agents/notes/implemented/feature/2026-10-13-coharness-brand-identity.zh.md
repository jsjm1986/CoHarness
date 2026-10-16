# Agent Note: CoHarness brand identity in the web client

Status: implemented

[English](2026-10-13-coharness-brand-identity.md) | 中文

## Problem

已上线的客户端没有统一的产品身份。各处混用 `CoHarness`、`DSH` 和 DeepSeek 时代的图案——locale 字典、gateway 门面页、管理端、应用图标各不相同；轮次活动指示器是本地化句子上的通用扫光，表达不出"正在执行"；品牌强调色依赖 `--dsw-alias-brand-primary`，而本主题把它映射到中性蓝灰——所以每个 React 面上的萤火虫都彻底丢了蓝色尾灯。

## Decision

产品身份是萤火虫吉祥物加大写宽字距 `COHARNESS` 字标，用在所有产品面上——hero、启动页、主侧栏与管理端侧栏、切换空间弹窗、gateway 四个门面页。独立的 C 标只保留为 favicon/应用图标，因为萤火虫在 16px 下不可读。全部强调色为纯色 `#2563eb`（亮色）/`#6b93ff`（暗色），无渐变。

`ui-primitives` 的 `CoHarnessMascot` 是唯一的吉祥物 React 组件。它的灯、光晕和余辉点挂 `coh-mascot-accent` 类，由 SVG 内嵌 `<style>` 上色——常规 `#2563eb`，`body[data-ds-dark-theme]` 下 `#6b93ff`——使标志在任何面上不查主题 token 也保持颜色。`busy` 属性渲染工作状态：每片翅膀由包一层保留绘制倾角的 `<g>` 承载，翼片自身用 CSS 绕根部扇动，身体微浮，灯呼吸；`prefers-reduced-motion` 冻结所有动效。

聊天 `TurnStatus` 把扫光句子换成 busy 锁版——振翅的萤火虫、`COHARNESS` 上逐字流过的蓝色脉冲、尾随三点——本地化的 `chat.deepDiving` 标签移入视觉隐藏文本，保住 `role="status"` 的读屏播报；计时仍在 15 秒后出现。展开态侧栏把锁版在行内容盒内居中（收起按钮绝对定位、不扭曲视觉中心）；管理端侧栏用裸标接字标、无容器瓦片，镂空按各宿主底色填充。

## Alternatives considered

**用 `--dsw-alias-brand-primary` 驱动强调色。** 否决：该 token 在本主题解析为中性蓝灰（亮色近黑、暗色近白），依赖主题 token 命名曾让尾灯在所有 React 面上失色，而自带 `--dsh-boot-accent` 的启动页却一直正确。把颜色收进组件自带 `<style>` 彻底移除了这层依赖。

**轮次活动保留扫光本地化句子。** 否决：它是通用 loader 观感、不带品牌，且需求是表达"正在执行"而非空闲加载。本地化文本仍在——作为 live region 标签——无障碍和计时契约不变。

**标志内用渐变强调。** 按产品方向否决：身份体系只用纯色；仅存的渐变是状态字标上移动的高亮光带，属于文字效果层而非 logo 图案的一部分。

**单一共享 mascot 资产供所有面消费。** 延后：现存四份独立表示——React 组件、启动页内联 SVG 串、gateway `html.ts` 标、admin-ui 副本——已经漂移过一次（admin 副本丢了光晕圆，后重新对齐）。收敛需要共享资产管线，仍待处理。

**侧栏锁版按整行居中。** 否决：绝对定位的收起按钮在行内，整行居中会让左侧留白明显偏大；改为在预留按钮宽度的内容盒内居中。

## Consequences

`ui-primitives` 之外的每份 mascot 副本靠手工同步、可能静默漂移——admin 副本已经漂过一次。每个新增带强调色的面都必须自带颜色规则；组件只覆盖 React 消费方。每个 busy 吉祥物实例都内联自己的 `<style>` 块。状态断言改为查品牌标记（`data-brand`、字标字母）加隐藏的本地化标签，而不是旧的可见句子。

修改共享模块导出（导火索是 `ui-primitives` 的图标改名）而不重建所有消费方，会留下在运行时崩掉槽位入口的旧 chunk——槽位边界内的 React #130 会把入口的 chrome 整体抹除。release 组装必须重建变更基线的全部消费方，不能只重建被改的包。同一构建还暴露了 rolldown 的空缺：没有此类边的 chunk 上 `implicitlyLoadedBefore` 与 `referencedFiles` 字段不存在，`web-product-bundle-isolation` 现在把两者都视为可选。

## Verification

`ui-primitives` 图标 spec 断言强调色 style 块与 busy 的翅膀/灯类名；`ui-conversation` chat-view spec 断言 live region 保留本地化标签和计时、并暴露 mascot 与字标；`ui-sidebar` 快照钉住非 busy 标记不变。真实浏览器检查用构建产物的 CSS 和 markup 在明暗两主题渲染，确认强调色取值 `#2563eb`/`#6b93ff`，并确认动画帧存在差异。
