# Agent Note: 托管 Ubuntu 运行器上有界的认证 APT 供给

Status: implemented

[English](2026-10-08-hosted-ubuntu-apt-provisioning.md) | 中文

## Problem

托管 Ubuntu 作业曾无界运行 `apt-get`：GitHub 的 `azure.archive.ubuntu.com` 镜像可能无响应挂起，重试循环放大停顿，产品证明步骤的预算被网络时间吃掉。Bubblewrap 通过完整 dpkg 事务获取，其装后工作并非 sandbox rung 所需。

## Decision

[scripts/prepare-ci-apt.mjs](../../../../scripts/prepare-ci-apt.mjs) 将托管镜像的 Azure 归档镜像替换为规范 `https://archive.ubuntu.com` 源，并把明文 HTTP 的归档、安全与 ports URI（amd64 与 arm64）升级为 HTTPS；无关源逐字节保留，包括 `Signed-By` 行、套件与组件，并写入 `98-dsh-ci-network` 精确有界设置（HTTP(S) 超时 20 秒、`Retries 0`、`APT::Update::Error-Mode any`、dpkg 锁 30 秒）。该模块幂等——重复执行报告零写入——并原样向上传播源 IO 失败；APT 负责源语法校验。[.github/actions/prepare-ci-apt](../../../../.github/actions/prepare-ci-apt) 仅对 `github-hosted` Linux 运行器暴露，并要求 root，持久 VM 与本机不受影响。

每个实质消费者在其 APT 事务紧邻之前、以消费者自身条件接入准备步骤：ci.yml 中四个 Playwright `--with-deps` 安装与 `Install Wine`、master 的 Wine 缓存未命中下载（先执行无凭据 `actions/checkout`，再运行本地准备动作与下载，因为组合动作需要已检出的工作树）、两个 landlock 工作流的 Linux musl 安装、以及 sandbox 的 Landlock 腿。每个供给步骤带 `timeout-minutes: 5`；sandbox 的 bwrap 腿改跑 [scripts/prepare-ci-bubblewrap.sh](../../../../scripts/prepare-ci-bubblewrap.sh)——SHA-256 固定的 .deb 载荷加有界 curl 参数——`timeout-minutes: 3`，使产品证明时间与网络时间分离。

## Alternatives considered

- **围绕 apt-get 的重试循环。** 重试只会放大挂起镜像的代价而非消除原因；规范归档加零重试有界策略同时移除慢路径与重试机器。
- **保留镜像地址不改。** Azure 镜像本身就是退化源；改写为规范归档是修复而非优化。
- **像其他工具一样经 apt 安装 bubblewrap。** 该 rung 只需 SHA-256 固定的 .deb 载荷加一个 AppArmor 旋钮；固定载荷抓取可审计且有界，并保留现有功能探针。

## Testing

[scripts/prepare-ci-apt.spec.ts](../../../../scripts/prepare-ci-apt.spec.ts) 用私有文件系统夹具检验写入器（镜像列表、旧式 `.list`、Deb822 `.sources`、签名保留、无关源、幂等、IO 传播、精确网络策略）。[scripts/prepare-ci-apt-workflow.spec.ts](../../../../scripts/prepare-ci-apt-workflow.spec.ts) 枚举五个所属工作流中全部 APT/Playwright 消费者，断言准备顺序、匹配条件、预算、VM 排除与固定载荷。托管 Ubuntu 运行提供这些夹具无法提供的网络证明。

## Consequences

规范源与显式步骤期限使供给失败有界且可归属：每次事务的网络时间上限为五分钟（固定 bwrap 抓取三分钟），签名态势不变，镜像内无关源逐字节保留。持久 failover VM 继续管理其镜像级 Playwright 包。[dual Wine and native Windows pull-request CI](2026-08-08-native-windows-pull-request-ci.zh.md) 保留其 lane 拓扑；[portable CI runner defaults](2026-09-02-portable-ci-runner-defaults.zh.md) 保留其运行器选择依据。
