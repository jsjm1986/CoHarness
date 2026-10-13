# Agent Note: 手机视口紧凑密度细化

Status: implemented

[English](2026-10-13-compact-density-refinement.md) | 中文

## Problem

第二轮 390×844 真机审计显示紧凑视口仍有大块桌面级残留：会话头部沿用了约 83px 的"标题+标签"两行配方，输入卡座占约 128px 桌面内边距，代码块保持 16px 卡片圆角和 44px 横幅，消息操作落在 44px 目标上，而每个会话行常驻三个尾部按钮——把 "NavScenario: first run…" 标题挤成了 "NavS…"。两个交互泄漏加重了臃肿感：触屏点按合成的 `mouseenter` 会武装悬停 tooltip、把气泡画在刚点过的控件上，审批接管卡则缺少紧凑配方（而提问卡、计划审阅卡早已具备）。

## Decision

只做密度收紧，不改布局结构。所有改动都是所属包内的 `[data-viewport='compact']` 或 `pointer: coarse`/`max-width: 767px` 规则——除两处刻意的行为修正外，没有 JS 契约、槽位或数据路径改动。

**会话头部。** 紧凑头收敛为应用顶栏下方的一条 36px 横带；标签轨道降到 34px、内部 28px 药丸、`mobile-font-secondary` 字体并可横向滚动，长标签不再挤压工具区。根侧间距降到 12px，正文列间距收紧为 `--dsw-space-3`，滚动区内缩为 clearance+6。

**输入区与正文。** 输入卡内边距收紧为 `6px 12px 8px` 并使用移动卡片圆角，工具行间距 4px；图标行继续沿用 40px 单行方案。用户气泡降为 `--dsw-radius-lg` 圆角、8px/12px 内边距；消息操作沿用同一 40px 目标族、放在可换行的 36px 行内；代码块采用 10px 卡片圆角、40px 横幅行、40px 复制钮和 10px 代码内缩——横幅是修饰而非点按行，因此跟随输入区的图标族而非 44px 触控目标。

**行与接管卡。** 会话行尾部只保留省略号菜单：`row.action` 槽位按钮包进 `display: contents` 壳，在紧凑与粗指针下整体隐藏——每个贡献者（置顶、归档）本就同时以 `menu.item` 发布同名动词，330px 宽的行上常驻三个 44px 按钮等于用标题换重复的可达性。选中行改为 `interactive-bg-active` 平铺填充——全宽抽屉里的凸起卡片读起来像按钮而非选中标记。`ApprovalPanel` 补齐了共享的紧凑接管配方（16px 圆角、`space-3` 内缩、可换行操作行），输入卡座切换不再跳宽度。

**悬停门禁。** `Tooltip` 在 `matchMedia('(hover: hover)')` 报告设备不支持悬停时不再武装 hover 触发；触屏和 jsdom 环境保留 focus/click 路径，合成 `mouseenter` 无法再把快捷键气泡钉在刚激活的控件上。

## Alternatives considered

**处处保持 44px 触控目标。** 否决：360–390px 宽下一行放不下五个 44px 控件的单行输入工具条和单行消息操作条；40px 族已是成文的紧凑折中（[输入区单行图标行](../bug-fix/2026-09-18-composer-single-icon-row.zh.md)），真正可交互的行（菜单行、选项行、会话行）仍保持完整触控目标。

**会话行操作改用滑动或长按手势。** 否决：行组件没有手势层，且省略号菜单已承载全部动词；把置顶/归档常驻成行内按钮只会继续挤压标题。

**接管卡单独做一套紧凑呈现器。** 否决：`QuestionComposer` 和 `PlanReviewPanel` 已共享 `@media (max-width: 767px)` 配方；ApprovalPanel 的分叉是遗漏而非意图，直接采用同一套规则。

## Consequences

手机端固定纵向开销减少约 40px，正文卡片不再像缩放的桌面窗口；会话列表恢复完整标题和单一尾部入口。非紧凑的粗指针设备（中宽度平板）保留 44px 规则；桌面构建在所有门禁规则之外逐字节一致。纯触屏设备上的悬停 tooltip 没有实际损失——气泡本就不适配该交互；具备悬停能力的设备（触控板、混合平板）行为完全不变。

## Verification

`apps/web/tests/mobile-density.e2e.ts` 在 390×844 下启动真实装配的应用并播种会话，断言紧凑标记生效、会话行可见尾部只剩菜单触发器、正文滚动口无横向溢出、合成悬停不产生 tooltip 气泡。`compact-chrome-styles.client.spec.ts` 与 `compact-styles.client.spec.ts` 的词法契约现在锁定 36/34/28px 头部配方和 40px 代码横幅族。390×844 截图审计覆盖了着陆页、抽屉（折叠与展开）、会话、输入区、详情浮层、轨迹流和设置底部弹层；1440×900 对照截图确认桌面框架不变。`ui-workspace`、`ui-conversation`、`ui-sidebar-right`、`ui-primitives` 测试套件全部通过。

## Related

- [2026-08-19 紧凑视口密度](2026-08-19-compact-chrome-density.zh.md)——本轮在其定义的紧凑/粗指针门禁约定上扩展。
- [2026-08-25 移动端导航与阅读密度](2026-08-25-mobile-density-pass.zh.md)——第一轮密度 pass；抽屉与 Markdown 节奏维持其决策。
- [2026-09-18 输入区单行图标行](../bug-fix/2026-09-18-composer-single-icon-row.zh.md)——操作行与代码横幅现共用的 40px 紧凑目标折中由其建立。
