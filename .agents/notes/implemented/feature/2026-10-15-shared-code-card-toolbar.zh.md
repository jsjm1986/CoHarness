# Agent Note:共享代码卡片工具栏统一换行、复制与语言头部

状态：已实现

[English](2026-10-15-shared-code-card-toolbar.md) | 中文

## 问题

`CodeBlock`、`ReadBlock`、`DiffBlock` 各自长出了自己的头部：围栏与读取卡片带语言横幅加复制按钮，diff 卡片则把复制浮在右上角、完全没有语言提示。三者都无法换行——读一条 200 列的行和未换行的 diff 都逼着横向滚动而无路可逃，而 `MarkdownText` 的 compact 变体仍渲染整条横幅。上游来源：`8d2cd0cf72090cc58fe8cfc9258ebbdf58ac9f1` 及其溢出修复 `f114233545f131bd8f16ddaa8487f4fe820dc8cd`（均在 alpha.2 内）；后续的间距/材质提交 `62f816f3a57` 与 `fdd14a09898` 留在本改动之外。

## 决策

`ui-primitives` 持有共享的代码卡片头部。`CodeCard.module.css` 一次性承载卡片外壳、标题行与正文规则，包括此前分散在各卡片内的紧凑移动端几何（44px 最小触达、768px 以下零纵向内边距、10px 横向内边距）。`CodeToolbar` 为每个代码族界面渲染标题栏：标题或语言标签、换行开关、复制控件。它的 `CodeToolbarLabels` 约定经 `MarkdownCodeLabels.toolbarLabels` 传到 Markdown，而 `MarkdownText` 在 `variant="compact"` 时剥掉该成员，因此紧凑界面（工具行、plan 预览、问题编写器）保留宿主样式而不继承整条工具栏。不传 `toolbarLabels` 的源码预览同样不渲染工具栏，让宿主 CSS 保持控制。

每张卡片自定换行默认，并把开关接到卡片根的 `data-code-wrap` 属性。围栏 `CodeBlock` 默认换行（`pre-wrap`），因为 Markdown 正文本来就折行；`ReadBlock` 与 `DiffBlock` 默认不换行（`pre` 加横向滚动），使行号与 diff 列保持对齐，开关按卡片挂载实例切到 `pre-wrap`——换行状态是局部 `useState`、从不上提，同一轮的两张卡片各自独立换行。换行按钮的可访问名跨状态固定（`codeBlock.wrap`，"自动换行"），由 `aria-pressed` 承载状态，tooltip 说明下一动作（`codeBlock.unwrap`/`codeBlock.wrap`）；图标在 `IconNowrapFill16` 与 `IconWrapFill16` 间切换以显示当前模式。缺失或未知语言落到本地化的 `codeBlock.title` 兜底（"代码块"），路径间语言不一致的 diff 取同一兜底而非挑某个文件的语法。复制永远写原始文本——绝非换行后的渲染、行号或工具栏——且卡片没有可复制内容时隐藏。

统一顺带带入两条溢出机制。`ReadBlock` 按返回的最大行号给行号栏定宽（`--dsl-read-gutter`，单位 `ch`，最小 3 位），因此偏移 99,999 的读取窗口行号栏留在卡片内而不压上内容。`DiffBlock` 把正文布局成 grid：未换行列 `minmax(max-content, 1fr)`、换行列 `minmax(0, 1fr)`，使增删行的背景填充铺满整条可横向滚动宽度而不再止于视口边；换行行用 `overflow-wrap: anywhere`，单个超长 token 仍能断开。两种行填充使用 `ui-theme` 新增的静态 alpha 令牌（`--dsh-diff-add-fill`/`--dsh-diff-remove-fill` 别名，架在主题无关的 alpha 色上），因为 diff 行必须在两套语法主题下、在主题相对背景失效的可滚动溢出里都保住填充。

## Alternatives considered

**各卡片自带工具栏。** 否决：三张卡片共享一个工具栏约定才能让标签、tooltip、图标触达与移动端密度一致；分散头部已经漂移（diff 卡片根本没有语言标签）。

**会话级或会话全局的换行偏好。** 否决：全局开关会让给一条长读取换了行、却想保留下一张 diff 列对齐的读者吃惊；按卡片的状态匹配上游行为，成本是每卡一个 `useState`。

**靠换可访问名来切换换行。** 为辅助技术否决：名字在"自动换行"和"取消自动换行"之间变化的控件，每次按下都被读作另一个按钮，因此名字固定，由 `aria-pressed` 加 tooltip 承载状态。

**compact 变体保留横幅。** 否决：compact Markdown 渲染在空间受限的座位里，整条标题行是视觉噪音；在 `MarkdownText` 剥 `toolbarLabels` 是唯一闸门，每个 compact 消费方免费获得省略。

## Consequences

会话、工具详情、 preset 指南、plan 预览与问题编写器中的每张代码族卡片呈现同一标题栏：语言标签、换行、复制。不换行界面保持 `pre` 滚动直到读者选择 `pre-wrap`；两种方式复制的文本相同。不传 `toolbarLabels` 的宿主样式预览——包括 `MarkdownText` compact——不渲染工具栏，因此本改动不可能回归自行设计头部的座位。diff 卡片的 grid 正文使长行填充铺满可滚动宽度、让换行 diff 留在视口内。没有可复制内容的卡片不暴露复制控件。标签在 `common` locale 命名空间（`codeBlock.title`/`.wrap`/`.unwrap`），任何 `TranslateNS` 消费方无需逐包加键即可解析。

## Verification

`packages/client/ui-primitives/tests/code-card-controls.client.spec.tsx` 钉住跨 `CodeBlock`、`ReadBlock`、`DiffBlock` 的共享头部：各卡片族的初始 `aria-pressed`、切换翻转它而可访问名保持 "Wrap lines"、tooltip 说明下一动作、复制收到未换行的原始文本、语言兜底标题、多语言 diff 兜底，以及不传 `toolbarLabels` 时不暴露工具栏。`diff-card.client.spec.tsx` 覆盖 grid 换行属性。`apps/web/tests/code-card-layout.e2e.ts` 驱动种子会话（读取偏移 999 与 99,999，加一次长行编辑）断言行号数字留在行号栏内、两种换行态源码对齐、换行 diff 落进视口而未换行溢出、明暗两套行填充铺满可滚动宽度、内嵌标记存在、控制台干净。`navigation-panes.e2e.ts` 覆盖活体围栏块：复制与换行 tooltip、`white-space` 在 `pre` 与 `pre-wrap` 间翻转、源文本不变，卡片快照进 `code-card.expected.md` golden。`ui-primitives` 套件、受影响的 `ui-tool`/`ui-conversation` 套件、client 构建与翻译配对均通过。

## Related

- [2026-07-30 Web diff 卡片](2026-07-30-web-diff-card.zh.md)——管 diff 分组、页脚与 `pre` 分歧；本 note 管该卡片现在挂载的共享头部。
- [2026-07-30 Web 读取卡片前端](2026-07-30-web-read-card-frontend.zh.md)——管读取 model 与 lazy 语法；工具栏标题读取其 model 产出的同一 `title`/路径。
- [2026-08-26 紧凑移动端代码与结果卡片](2026-08-26-mobile-code-card-density.zh.md)——管手机密度决策；共享卡片样式表现在承载工具栏卡片的那些规则。
