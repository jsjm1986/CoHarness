# Agent Note:CI 安装重试与 Windows-native 超时地板

Status: implemented

[English](2026-11-19-ci-install-retries-and-windows-timeout-floor.md) | 中文

## Problem

2026-11-18 当天，两类托管 runner 故障反复打红本应全绿的 CI。其一,`timeout-minutes: 5` 的单发下载步骤——四个 Playwright 浏览器安装(benchmarks、web 快照、Linux audit、浏览器缓存)、CJK 字体安装和 Wine 安装——一天内超时约九次。每个步骤在一条连接上跑一条命令,镜像站或 CDN 边缘节点一旦停滞必然烧尽全部预算并失败作业,而新连接几乎总能成功。其二,`DSH_COVERAGE_TEST_TIMEOUT_MS: '90000'` 在 windows-native lane 失效:托管池中一次劣化 runner 抽签在 run 44376483787(三次尝试)和同 base 的 master run 44371214606 中,把十余个 `lsp-stdio` 生命周期用例各推过 90 s,而整个文件在健康 runner 上仅需约 6 s。

## Decision

每个易停滞的安装步骤改为有界重试循环:`timeout -k 30 240` 将单次尝试封顶四分钟并留 30 s 强杀宽限,最多三次尝试,间隔十五秒,步骤预算升至 `timeout-minutes: 20`。不带 `--foreground` 的 GNU `timeout` 向该尝试的整个进程组发信号,apt/dpkg 子进程不会存活到下一次尝试;若强杀落在解包中途仍可能留下破损的包状态,因此每次重试先执行 `dpkg --configure -a` 与 `apt-get install -f -y`。重试用新连接替换烧掉预算的死连接,而不是延长死连接的占用。

windows-native lane 的地板 `DSH_COVERAGE_TEST_TIMEOUT_MS` 从 90000 提到 180000。地板仍压制当初 30 s→90 s 上调所针对的常规托管 runner 停滞,现在也覆盖把 lsp-stdio 推过旧值的中度劣化抽签。彻底卡死的 runner 依旧失败——没有有限地板能救它——作业级 rerun 仍是这类抽签的泄压阀。

## Alternatives considered

弃用第三方 retry action:它为一个短 bash 循环能直接表达的逻辑引入供应链依赖。弃用单纯加长单次尝试超时:停滞的连接极少自愈,同样预算下换新尝试严格更优。弃用逐测试的 Vitest `--retry`:它同时掩盖真实的产品 flake;重试应放在下载/安装边界——失败来自网络而非被测代码。弃用"等 `20261103` runner 镜像退出池"作为唯一手段:run 44376483787 通过的 attempt 抽到的镜像版本与三次失败完全相同,劣化跟随的是单台 VM 而非镜像发布批次。

## Verification

六个重写的 `run` 块均通过 `bash -n` 解析,workflow YAML 加载并解析出全部 25 个 job。地板值经 `coverageTestTimeoutOptions` 流入 `testTimeout`、`hookTimeout` 与 `expect.poll.timeout`,该映射由 `scripts/coverage-partitions.spec.ts` 钉住。引入本变更的 CI run 实际执行了每个重试步骤(无条件执行)和新地板下的 windows-native lane。

## Consequences

三次尝试全部停滞的下载步骤现在最多烧约 14 分钟才失败,原先五分钟即败;停滞后恢复的连接现在能通过。windows-native 最坏情形 lane 时长仅对真实停滞的测试增长,每个至多增加 90 s。劣化超过新地板的抽签仍会失败,这是有意保留的信号而非被压制的噪音。
