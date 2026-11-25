# Agent Note：硬化 Web e2e 就绪等待并通过路由捕获启动回复

状态：已实现

[English](2026-11-25-web-e2e-contention-hardening.md) | 中文

## 问题

`web verification` lane 能够跑完清单后，暴露了两类相互独立的 Web e2e 失败。`session-export-responsive` 在 CI 全部十七个 viewport 变体失败而本地通过：导出入口按钮只在 workspace 加载完成后挂载，观察它的 `expect.poll` 带着五秒 expect 默认值，托管 runner 双 pool worker 的同文件并发可靠地将其耗尽。`runtime-start-feedback` 在任何环境都读不到启动回复体：CDP `getResponseBody` 在渲染进程消费错误响应后从不暴露它，即使在响应事件内读取也抛 `No data found for resource with given identifier`。

## 决策

`session-export-responsive` 的就绪轮询现在带显式三十秒预算，与兄弟套件已声明的退化余量一致；同一预算延伸到 `workspace-review` 的交付与变更卡片轮询及 `personal-navigation-resume` 的离线电脑重试等待，而 schedule 管理页就绪等待升至六十秒，因为导航本身要排在同文件浏览器工作之后。`settings-chrome` 的 boot 画布测量从加载提示走 `parentElement.parentElement`，被 boot 页 progress 包装层重构破坏；断言失败还跳过了测试自身的偏好恢复，级联出后续主题翻转测试的深色偏好污染失败。测量现在锚定 boot 根元素的稳定 `data-dsh-boot` 属性。`admin-runtime-start-browser.mjs` 通过 `page.route` 代理启动 POST：`route.fetch()` 执行到 fixture 服务器的真实往返，测试直接捕获状态码与 JSON，再 `route.fulfill({ response })` 把未动的回复交给页面——UI 观察到真实交换，测试不再依赖 CDP body 留存。

## 备选方案

- **全局提高 expect 超时**——会掩盖其他所有套件的就绪回归，且违背 resilient 文件已显式声明的逐等待预算。
- **在事件监听器中即时读 body**——首先尝试过；CDP 对错误回复仍无 body，证明缺陷在留存机制而非时序。
- **只断言状态码**——会丢掉区分 fixture 拒绝形态与无关失败的 `node-service/unavailable` 负载契约。

## 影响

两个修复均经本地验证：`runtime-start-feedback` 5/5 通过，`session-export-responsive` 18/18 通过。等待 workspace 启动的套件应声明显式轮询预算而非继承 expect 默认值；捕获错误响应负载的套件应走路由代理而非读 CDP body。相关：[Admin 矩阵预算笔记](2026-11-25-admin-matrix-hosted-budget.zh.md)覆盖这些等待现在所容忍的 lane 级并发结构。
