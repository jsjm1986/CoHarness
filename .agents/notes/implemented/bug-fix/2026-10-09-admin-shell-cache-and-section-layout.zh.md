# Agent Note：管理端 SPA 缓存策略与区块内控件行

Status: implemented

[English](2026-10-09-admin-shell-cache-and-section-layout.md) | 中文

## 问题

两处缺陷导致管理端把控件渲染到区块卡片之外。`serveAdmin` 不发送任何 `cache-control`，启发式缓存可能在版本切换后钉住 `index.html`：旧外壳继而引用已不存在的哈希分块，过期或残缺加载的 bundle 把控件画在卡片外。另外，两个页面的操作位没有遵守共享的行容器约定：插件页的管理对象选择器让裸 `Button` 直接贴着 `Field`，没有任何行容器；部署页的维护表单把提交操作作为 `formGrid` 里的裸单元格，浮在输入框旁边而非与之对齐。

## 决策

`serveAdmin` 为每个管理端响应发送显式缓存策略：SPA 外壳与错误响应携带 `no-store`；被服务的文件（`assets/` 下按内容哈希命名）携带 `private, max-age=31536000, immutable`。`private` 让需要鉴权的 bundle 不进入共享缓存。

字段与操作配对的控件放进专用行容器：插件页的对象选择与重新读取共享 `.targetPicker`（底边对齐的 flex 行，窄屏下换行），部署页的维护提交放在字段下方的 `.formActions` 中。

## 备选方案

**给外壳本身加指纹。** 否决：外壳的文件名就是它的 URL，`index.html` 用 `no-store` 加内容哈希资产是标准做法，代价只是每次导航多一次条件请求。

**插件选择器复用 `.filterPanel`。** 否决：该类的 filter-grid 间距为多控件筛选条而调；专用的双项行容器让选择器保持最小化，同时沿用同一底边对齐约定。

## 后果

版本切换不会再让被钉住的外壳指向已删除的分块；每次导航都会重新验证外壳，而哈希资产保持缓存。表单操作在桌面端与字段对齐，在手机端收进卡片内换行。凡是字段与操作配对的新区块都应复用这些行容器，而不是平铺裸控件。

## 验证

`gateway/tests/admin-static.spec.ts` 断言外壳、嵌套 SPA 路由、缺失与越界路径携带 `no-store`，哈希资产携带 `private, max-age=31536000, immutable`。`apps/web/tests/admin-layout.e2e.ts` 通过鉴权 HTTP 驱动构建产物，断言重新读取与维护按钮在桌面端与各自字段同行底边对齐，并在 `390px` 下保持在各自区块卡片内、无页面级横向溢出。
