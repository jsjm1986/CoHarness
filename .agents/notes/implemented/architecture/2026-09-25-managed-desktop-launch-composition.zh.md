# Agent Note: 由节点配置组装托管桌面驱动

Status: implemented

[English](2026-09-25-managed-desktop-launch-composition.md) | 中文

## 问题

Gateway 启动的运行时只加载组合补丁中列出的插件。管理员授权与托管桌面策略已经存在，但没有任何启动的运行时注册过桌面驱动，托管桌面路径无法执行真实调用。

## 决策

Gateway 通过节点配置管理驱动准入。`HGW_DESKTOP_ID` 声明本节点的交互桌面标识。设置后，启动组合把已配置的 Cua Driver MCP 包物化进运行时 profile，向托管补丁追加 `dsh-computer-use` 与驱动条目，并写入 `gateway-execution` 的 `config.desktop`，由其为该标识发布托管策略。未设置时，运行时不挂载驱动、不发布策略，也不会读取驱动包。

驱动包与 model-governance、directory-guard 包走同一套原子暂存物化机制：`HGW_DESKTOP_DRIVER_PACKAGE` 指向绝对包目录，只复制其中的 `package.json`、`lib/` 和 `cordis.patch.yml`，绝不符号链接到源码检出。发布部署把默认路径钉在 `HGW_RELEASE_ROOT` 下；包缺失或不完整时运行时挂载大声失败。`HGW_DESKTOP_DRIVER_COMMAND` 与 `HGW_DESKTOP_DRIVER_ARGS` 用字面量命令和 JSON 参数列表替换提供者的 `cua-driver` 可执行文件查找与 `mcp` 参数向量，不经过 shell。

`dsh-computer-use` 通过安装模块回退解析，因为 `gateway-execution` 已把它声明为 peer；只有驱动包需要物化。补丁只发出一行驱动条目，保持服务的单提供者不变量。`HGW_DESKTOP_ID` 接受 1 到 256 个字符，与运行时 `desktop` schema 的上界一致。

## 已考虑的替代方案

- **在治理补丁中写静态行并用 `!!js` 门控：** 实验驱动包不在发货插件集内，门控行会指向一个无法解析的包；而且桌面标识属于节点配置，不属于补丁内容。
- **`OPTIONAL_BUNDLES` 用户可选槽位：** 可选 bundle 是用户为个人 profile 选择的 CLI 层；托管桌面是管理员控制的部署行为，不能依赖用户逐项选择。
- **无条件挂载：** 没有桌面的节点仍会启动驱动，并为一个不存在的资源发布策略。
- **把 browser-use 纳入托管路径：** 暂缓；它还没有托管授权缝，挂载后会脱离策略运行。

## 相关决策

[托管桌面执行 note](2026-09-23-managed-desktop-execution.zh.md) 拥有本组合所激活的策略、资格、确认与租约语义。[提供者注册 note](2026-09-12-computer-use-provider-registration.zh.md) 拥有补丁行所满足的单槽位注册契约。

## 影响

启动组合依赖已配置的驱动包；包缺失会让每次启动失败，直到部署方修复。升级驱动就是替换已配置的包目录。启用桌面的节点上，每个个人与项目运行时都携带该驱动，运行时策略仍按当前资格与活动根确认逐次拦截调用。测试覆盖缺省关闭、启用行、命令与参数覆盖、发布根钉定、物化产物以及包缺失失败。
