<!-- 写 Fixes #NN 表示解决并自动关闭；写 Related to #NN 仅关联。 -->
<!-- 进入评审的非 Draft 人类 PR 至少引用一个同仓库 Issue。 -->
<!-- 解决型 PR 与 Issue 同步 Priority；解决多个 Issue 时取最高值。 -->

关联 Issue：

<details>
<summary>变更与验证</summary>

- 变更：
- 验证：

</details>

<details>
<summary>合并前检查清单</summary>

- [ ] 已基于最新 `master`，并确认 PR base、head 与依赖 PR 的 exact SHA。
- [ ] 已运行与变更范围匹配的 focused tests、typecheck、lint/build 和必要的打包或运行时 smoke。
- [ ] 源码变更仍满足 changed-source coverage；模型可见行为已通过 keyless snapshot/replay。
- [ ] 已区分 blocking、baseline-observation 与 environment-observation；没有用平台红灯掩盖代码失败。
- [ ] snapshot 仅在显式 record workflow 中使用密钥；普通 PR 不重录 fixture。
- [ ] stacked PR 已按 parent → child merge-forward；独立 PR 不手工猜测依赖关系。
- [ ] 涉及发布或部署时，已验证 release manifest、实例 readiness、回滚路径和公网入口。

</details>
