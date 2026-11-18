# Agent Note: Release order optional-peer and stack-member edges

状态：已实现

[English](2026-11-16-release-order-optional-peer-edges.md) | 中文

## 问题

`release:pack --family dsh` 的拓扑发布序在环 `host-apiproxy →(install dep)→ api-remotes →(peer)→ client-connection →(peer)→ host-apiproxy` 上失败。两条排序规则对该图都不成立。其一，`peerDependenciesMeta.optional` 的 peer 被当作硬发布约束，但 optional peer 安装时本可缺席，无权要求发布位置。其二，peer 边遍历可以把 install-dep 祖先仍在 DFS 栈上的包提前落位——在真正需要它的依赖者之前安装——因此跨越未完成 install 链闭合的 peer 边会制造出不可解的假环。

## 决策

- `orderEdges` 跳过 manifest 标记为 optional 的 peer 边（`peerDependenciesMeta.<name>.optional`)，与 npm 语义一致：optional peer 不提供安装保证。
- peer 遍历时若目标包的 install-dependency 祖先仍在 DFS 栈上，则丢弃该 peer 边并记录丢弃，而不是构造假环。

## 影响

- dsh 家族以合法发布序打包（370 个 tarball),packed-install 冒烟安装 380 个 tarball 且 `dsh` 报告发布版本。
- 仍然存在的真环——install-dep 回环，或成员间无 install 祖孙关系的 peer 回环——依旧响亮失败，并附丢边记录供诊断。

## 备选方案

- 把 `client-connection` 对 `host-apiproxy` 的 peer 改成 dependency——否决：该裸导入位于 `lib/index.js` 且规则 6 已管辖此边；为迁就排序缺陷放松真实约束只会掩盖缺陷。
- 仅手工调整本例顺序——否决：缺陷在遍历规则，今后每个加入同型结构的包都会复发。

## 验证

- `families.spec.ts` 新增 optional peer + install 祖先混合环用例；套件 28/28 通过。
- `pnpm run release:pack --family dsh` 产出全部 370 个 tarball;packed-install 冒烟安装 380 个 tarball,`dsh --version` 报告产品构建。
