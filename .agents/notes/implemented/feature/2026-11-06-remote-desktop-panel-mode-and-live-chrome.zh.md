# Agent Note: 远程桌面标签页通过其绑定动作驱动面板显示模式

Status: implemented

[English](2026-11-06-remote-desktop-panel-mode-and-live-chrome.md) | 中文

## 问题

RFB 流是一条存活套接字，不是可以免费重渲染的视图。在本次改动之前，`remoteDesktop` 侧边栏标签页与普通页面行为相同：取消选中会卸载正文，因此每次切换标签都拆断流，下次访问重新挂接——并重新应答服务器的一切凭证挑战。标签页也无法使用面板的显示模式：远程桌面想要整幅画面，而表面的 `push`/`fullscreen` 切换只在面板 chrome 上，操作者每次打开都要手动去点。最后，流无法在不重连的情况下就地调参——没有缩放、没有画质权衡、没有 Ctrl+Alt+Delete。

## 决策

`SidebarRightTabActions`——每个标签页正文经 `useTabInfo()` 已持有的绑定动作面——携带 `setPanelMode(mode: DockMode)`，与面板 chrome 控件相同的 `push`/`fullscreen` 操作。Tab 域把它转发给 `SidebarRightController.setPanelModeIn(sessionId, mode)`，后者应用该会话已采用 store 的动作；store 从未被采用的会话则什么也不做。表面范围的模式仍归表面所有：正文只能为自己所属会话发出请求，走的正是让 `tab.actions.openResource` 落在自己分栏内的同一条路由。[Right Sidebar tab types and navigation](../architecture/2026-09-05-sidebar-tab-types-and-navigation.zh.md) 拥有该动作面，并曾把显示模式操作留在导航控制器之外；本决定保持该面不变，把操作放在标签页自己的动作上。

`remoteDesktop` 类型声明 `keepMounted`，其已访问正文在切 tab、切会话、收起与重新停靠之间保持挂载而不重新挂接。流存活且可见后，正文调用 `setPanelMode('fullscreen')`——每次挂载一次，因此退出全屏的操作者在正文重新挂载前不会被拉回去——正文自己的 chrome 在两个方向上都暴露该切换。存活工具栏在流上就地调参而非重连：**适应**/**1:1** 缩放对应 `scaleViewport` 或 `clipViewport` 加 `dragViewport` 平移；三个具名画质预设对应 Tight `qualityLevel`/`compressionLevel`；`resizeSession` 请求具备 ExtendedDesktopSize 能力的服务器跟随容器尺寸，无此能力的服务器忽略该请求；**Ctrl+Alt+Del** 在可操控授权下出现；级别徽标、录制标志与**断开连接**/**重新连接**补全整个 chrome。

## 已考虑的替代方案

**在 `ctx.sidebarRight` 导航面上加 `setMode`。** 侧边栏标签类型决定已权衡过该处的模式操作并将其排除：该面是对布局的控制，模式调用需要一个捕获目标，其过期性由调用方管理。标签页绑定的动作不需要目标——occurrence 自带其会话——也无法作用于不属于它的会话。

**每次访问重新挂接，而非 `keepMounted`。** 否决：对视觉上的标签切换付出一次握手、并在交互式端点上付出一次新的凭证挑战并不值得。保留一个可能再不被访问的画布要付出内存，而 `keepMounted` 的仅已访问规则已经约束了这一点。

**持久化的自动全屏偏好。** 否决：退出全屏的操作者对这次观看表达了相反意图；在每次可见性变化时重新应用会与用户对抗。每个正文挂载只请求一次，把拉动限制在流真正到达的时刻。

**为工具栏开一个远程桌面专用席位。** 否决：chrome 是内容级的，不需要席位；现有原语（`SegmentedControl`、`Menu`、`Button`）即可在正文内组合。

## 后果

一个所有标签页正文测试夹具都会 mock 的公开面增加了一个必选成员；远程桌面标签页在切 tab 之间保住它的流——以及一切已应答的凭证挑战。就地调参局限于已打开的流：缩放与画质变化只作用于当前 RFB 客户端，不流向别处。每次挂载一次的全屏请求意味着正文重新挂载——例如标签类型被重新渲染之后——会再次请求全屏；为不持久化偏好，接受这一次多余请求作为代价。`setPanelMode` 有意不出现在 `ctx.sidebarRight`：布局控制留在导航面之外，外部调用方仍无法移动面板。

## 验证

`remote-desktop-body.client.spec.tsx` 以 mock 的 screen 驱动正文，断言全屏请求在流存活时恰好发出一次、缩放与画质 chrome 就地调整存活画面，以及 Ctrl+Alt+Delete 与全屏控件分别路由到 `sendCtrlAltDel` 与 `setPanelMode`。
