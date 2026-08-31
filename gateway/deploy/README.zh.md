# 生产部署手册

[English](README.md) | 中文

在 Linux 主机上以 systemd 内核约束上线网关，并把公网域名切换到它。全文使用的布局：网关代码在 `/srv/harness/gateway`，数据在 `/srv/harness/gateway-data`，用户目录在 `/srv/harness/users` 下，管理员登记的项目数据在 `/srv/harness/projects` 下，用户创建的项目数据在 `/srv/harness/projects/user-projects` 下，共享项目运行时 home 在 `/srv/harness/project-runtimes` 下，目录守卫在 `/srv/harness/plugins/dsh-directory-guard`，强制模型治理在 `/srv/harness/plugins/dsh-model-governance`。

## 前置条件

- 带 systemd 的 Linux、root 权限、Docker Compose、供一次性导入/回滚使用的 `sqlite3`，以及 Node 25（`/usr/local/bin/node`；nvm 布局需调整单元内路径）。创建共享项目单元使用的不可登录 `harness-project` 账户，创建各个 `HGW_PROJECT_PATH_ROOTS` 目录，并授予该账户这些根目录下每个项目目录所需的 Unix 读写权限。每个配置根都会成为管理员宿主机浏览器的一项顶层入口；根本身只能导航，导入项目必须是其严格后代。两个受控根都必须让后续创建的目录继承运行时访问权，例如执行 `install -d -o root -g harness-project -m 2770 /srv/harness/projects/admin /srv/harness/projects/user-projects`（无法使用组继承时改用等效默认 ACL）。setgid 父目录会让 Gateway 以 `0770` 创建的项目目录带上共享运行时组。
- 钉死版本的 dsh：`npm install -g @deepseek-ai/dsh@0.1.0-rc.8`（升级 = 改版本号 + 滚动重启，绝不检出源码）。注意：开发 clone 里未提交的本地工作（例如 UI 改动）在合入上游前不在 npm 发行版内。
- 公网域名的 DNS/入口控制权（Nginx 或 Cloudflare Tunnel）。

## 安装

在精确的发布 checkout 中执行 `pnpm install --frozen-lockfile && pnpm run build:production`。该生产入口会构建 Harness 库与 Web 应用、两个树外插件和 Admin SPA，对 Gateway 做类型检查，并在缺少任何 CLI、Web、Gateway、Admin、插件、管理员覆盖层或协作 migration 产物时拒绝发布。

1. 把构建完成的 `gateway/` 目录复制到 `/srv/harness/gateway`，把 `packages/llm/llm/` 复制到 `/srv/harness/packages/llm/llm`，并保留这一相对布局；`build:production` 会在 `gateway/lib/` 生成 Gateway 入口及其本地模块，并创建编译 ESM 图所需的相对链接 `gateway/node_modules/@deepseek-ai/dsh-llm`。使用生产 Node 在 Gateway 目录执行 `npm install && npm rebuild better-sqlite3 argon2`，然后由纯 Node 启动 `lib/index.js`。编译后的 Gateway 保留 `@deepseek-ai/dsh-llm/discovery` 包导入，因此相邻包的构建 `lib/` 与生成的链接都必须包含在 release 中；新激活不使用源码 `tsx` loader，release controller 仍允许把只有源码的旧 release 作为回滚目标。`public/admin` 已被 gitignore，因此只能在 `build:production` 生成该目录后再从 checkout 复制。
2. 把构建完成的 `plugins/dsh-directory-guard/` 目录复制到 `/srv/harness/plugins/dsh-directory-guard`，把 `plugins/dsh-model-governance/` 复制到 `/srv/harness/plugins/dsh-model-governance`。钉死的 npm dsh 以纯 Node 运行插件 `lib/`，不使用 tsx。即使 `HGW_GUARD_PATCH=off`，模型治理仍是强制项。
3. 把公司默认凭据写入 `/srv/harness/gateway-data/company.env`（`DEEPSEEK_API_KEY=...`，权限 600）。每次运行时启动都会把它复制到 `$DSH_HOME/.env`；用户在 Settings 里设置的个人 key 存放于 `.credentials.yaml`，优先级更高，共享项目运行时则把凭据设置暴露为只读并使用公司来源。
4. 启动 [`deploy/postgres/`](postgres/README.zh.md)，应用 migration，并创建权限为 `0600` 的数据库 URL 文件。在启动 Gateway 前，导入冻结的 SQLite 控制面，或创建配置的企业与计算节点。
5. 创建仅所有者可访问的 `/srv/harness/gateway-data/principal-keys` 和 `/srv/harness/gateway-data/runtime-credentials`，以及 `/srv/harness/project-runtimes` 和项目根目录。为两个受控根配置组继承，例如执行 `install -d -o root -g harness-project -m 2770 /srv/harness/projects/admin /srv/harness/projects/user-projects`；通过显式路径导入的目录仍需显式授予 `harness-project` 读写权限。把 `deploy/harness-gateway.service` 复制到 `/etc/systemd/system/`；调整数据库 URL 文件、`HGW_ORGANIZATION_SLUG`、`HGW_COMPUTE_NODE_NAME`、`HGW_PUBLIC_ORIGINS`、`HGW_PROJECT_PATH_ROOTS`、`HGW_PROJECTS_ROOT`、`HGW_USER_PROJECTS_ROOT`、项目运行时账户/根目录、principal/凭据目录、插件路径和其他宿主机路径，然后执行 `systemctl daemon-reload && systemctl enable --now harness-gateway`。
6. 数据库中没有用户时，首次启动会创建权限为 `0600` 的 `/srv/harness/gateway-data/bootstrap-admin-password`，日志只记录文件路径。以 root 读取后登录一次、修改密码，再用 `shred -u` 或等效的仅所有者删除方式清理文件。曾把密码写入 journal 的既有部署必须人工轮换管理员凭据并检查留存日志。

Admin 归档频道由 PostgreSQL migration 015 启用。可通过 `HGW_ARCHIVE_RETENTION_DAYS`（默认 `30`）设置回收站保留窗口。运行时归档快照通过私有 Gateway API 对账；运行时 home 与 Gateway 归档索引必须纳入同一套备份方案。个人正文仍保存在运行时自己的存储中，由管理员阅读器按需读取。

## 每用户开号

在 `/admin` 创建用户，然后以 root 执行一次 `deploy/provision-user.sh <username>`：它创建 `harness-<username>` 系统账号并 chown `/srv/harness/users/<username>/{home,dsh}`。个人单元在每次启动时按该用户当前授权自动渲染。管理员发起的项目可以在 `HGW_PROJECTS_ROOT` 下得到 `0770` 受管目录，也可以导入从 `HGW_PROJECT_PATH_ROOTS` 下选择的既有目录；导入目录需要显式授予 `harness-project` 读写权限。用户发起的项目仍只提交名称，并在 `HGW_USER_PROJECTS_ROOT` 下创建空目录；前面的 setgid/默认 ACL 配置会让项目单元继承访问权，创建者成为 `rw` 所有者。两种来源都分配一个共享运行时，支持 `ro`/`rw` 邀请，并使用同一套对话与文件夹 scope。项目目录不能与用户数据、运行时或凭据数据、Gateway/发布/插件代码、用户受管项目存储或另一项目重叠。成员身份和个人目录权限写入会在需要时重启正在运行的个人运行时；项目 ACL 按请求检查，不要求重启共享运行时。管理员在个人和项目 scope 都保留 `danger-full-access` 预设，但项目运行时仍受内核项目路径约束。

## 数据库切换与回滚

最终导入前先停止现有 Gateway，防止任何 SQLite 写入与权威切换竞态。创建 SQLite 在线备份，把这份独立文件导入配置的 PostgreSQL 企业/节点，再运行 `pg:backup` 与 `pg:restore-check`。四项操作全部成功后才能启动 PostgreSQL Gateway。认证会话与 intake token 明确不在导入范围内，因此重新登录并重新投影实例策略是预期行为。

冻结的 SQLite 备份必须与切换前的精确 Gateway 产物一起保留。回滚会停止 PostgreSQL Gateway，恢复这两份产物，并且只启动 SQLite 版本。不得复制正在使用 WAL 的数据库、不得让两个版本同时运行，也不得尝试把 PostgreSQL 写入合并回 SQLite。PostgreSQL 保留用于诊断和后续干净切换。

## Android 薄壳与推送通道

Android 应用 id 是 `com.coharness`。在 JPush，以及需要使用时的 Firebase 和华为控制台，都必须注册这个 id。薄壳可以只使用 JPush，也可以与 FCM 和可选的厂商通道组合使用。所有凭据都必须放在 Git 之外。

使用 JPush 时，在构建时通过 Gradle 属性或环境变量设置 `JPUSH_APPKEY`。薄壳只在 Android 通知权限获准后初始化 JPush，并在后续启动中记住该授权。module 默认使用 JPush `6.2.0`；可用 `JPUSH_ENABLE_HUAWEI`、`JPUSH_ENABLE_FCM`、`JPUSH_ENABLE_XIAOMI`、`JPUSH_ENABLE_OPPO`、`JPUSH_ENABLE_VIVO`、`JPUSH_ENABLE_MEIZU` 或 `JPUSH_ENABLE_HONOR` 启用厂商插件。华为需要 `apps/android-shell/android/app/agconnect-services.json`；FCM 需要 `apps/android-shell/android/app/google-services.json`。这些文件只是部署构建输入，不得提交仓库。

Gateway 发送端需要把 JPush Master Secret 和 Firebase service-account JSON 以 `0600` 权限保存到主机。启用 JPush 时同时设置 `HGW_JPUSH_APP_KEY` 与 `HGW_JPUSH_MASTER_SECRET`；启用 FCM 时还要设置 `HGW_FCM_PROJECT_ID` 与 `HGW_FCM_SERVICE_ACCOUNT_FILE`。Gateway 正常启动会应用 PostgreSQL migration 010，使 FCM 与 JPush Token 在各自 provider 内保持唯一。

使用 Java/Android SDK 工具链并指向已部署 Web UI 构建薄壳。当前部署使用 `DSH_ANDROID_WEB_URL=https://harness.maycran.com/ pnpm --dir apps/android-shell run build`、`DSH_ANDROID_WEB_URL=https://harness.maycran.com/ pnpm --dir apps/android-shell run cap:sync`，然后执行 `cd apps/android-shell/android && ./gradlew assembleRelease`。发布普通 Web UI 资源不需要再次构建 APK；只有原生工程、权限、包名、图标或通知处理逻辑变化时才重建。AI turn 完成后，Gateway 会向会话创建者的设备发送包含会话 id 和事件序号的通知，点击后打开现有 Web UI 会话。

## TLS 入口与切流

把公网域名指向网关，并关闭实例直连端口。Nginx server 块要点：

```nginx
server {
  listen 443 ssl;
  server_name harness.maycran.com;
  location / {
    proxy_pass http://127.0.0.1:8899;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
  }
}
```

切流清单：设置 `HGW_PUBLIC_ORIGINS=https://harness.maycran.com`（Secure Cookie 随之开启），把入口上游改为 `127.0.0.1:8899`，然后**停掉此前直接暴露的单个 dsh 实例**（或改绑回环）——切流后除 TLS 入口外任何来源都不得触达主机端口。

## 验收

- 网关行为：`HGW_ACCEPT_DATABASE_URL=postgresql://.../harness_accept bash scripts/accept-phase1.sh`（需要库名以 `_test`、`_accept` 或 `_acceptance` 结尾的临时 PostgreSQL 数据库；无需 API key）。
- 内核约束：以测试用户登录一次让单元启动，然后 `sudo bash scripts/accept-phase2.sh <user> <other-user> [ro-path] [rw-path]`——从挂载命名空间内部验证同伴不可见、自身主目录可写、`ProtectSystem`、ro/rw 授权语义。把会话切到 `danger-full-access` 后重跑：内核边界必须保持不变。
- 协作：让两个测试用户加入同一项目，验证共享历史与参与者归属；再把一位成员改为 `ro`，确认 composer 和直接 Host 写入/审批路径都拒绝；确认第二位成员看不到私密对话。
- 项目生命周期：从账户创建一个用户发起项目，接受邀请，并确认管理端项目列表能区分管理员发起和用户发起。分别以管理员进入个人和项目 scope，确认返回 `fullAccess`；确认普通成员不能通过 `/permission` 或新会话默认设置选择该预设。
- 重启韧性：`reboot` 后确认 `harness-gateway` 活跃，个人/项目登录都能重新到达可用运行时。

## macOS 变体（launchd，隧道入口）

隧道后的 macOS 主机以 `HGW_LAUNCHER=local` 运行 Gateway，并用 launchd 取代 systemd。launchd 任务执行 release 树外的 [`macos/release-control.sh`](macos/release-control.sh) 稳定副本，工作目录则是稳定的 releases 根目录。plist 与宿主环境不得分别引用 `current`；控制器在每次 Gateway 启动时只解析一次 `current`，并把得到的规范目录作为 `HGW_RELEASE_ROOT` 导出。[macOS release 生命周期原子化](../../.agents/notes/implemented/process/2026-08-18-atomic-macos-gateway-releases.zh.md)记录了操作顺序与回滚决策。

先把控制器安装到 release 清理不会删除的位置，再创建仅所有者控制的环境文件：

```sh
install -d -m 700 "$HOME/.local/libexec/harness-gateway" "$HOME/.config/harness-gateway"
install -m 700 gateway/deploy/macos/release-control.sh "$HOME/.local/libexec/harness-gateway/release-control.sh"
touch "$HOME/.config/harness-gateway/launch.env"
chmod 600 "$HOME/.config/harness-gateway/launch.env"
```

`~/.config/harness-gateway/launch.env` 保存稳定的宿主配置。按部署需要把项目、凭据、推送和额度变量放在这里，但不要设置 `HGW_RELEASE_ROOT`、`HGW_DSH_COMMAND`、`HGW_DSH_REPO_ROOT`、`HGW_MODEL_GOVERNANCE_PACKAGE` 或 `HGW_GATEWAY_DIR`；控制器与 Gateway 会从同一个 release 派生这些值：

```sh
HGW_NODE=/Users/ACCOUNT/.nvm/versions/node/v25.8.1/bin/node
HGW_RELEASES_ROOT=/Users/ACCOUNT/harness-gateway-releases
HGW_DATABASE_URL_FILE=/Users/ACCOUNT/.config/harness-gateway/database-url
HGW_DEFAULT_ENV_FILE=/Users/ACCOUNT/harness-gateway-data/company.env
HGW_COMPUTE_NODE_NAME=mac-mini
HGW_ORGANIZATION_SLUG=internal
HGW_PORT=8899
HGW_INTAKE_PORT=8900
HGW_PUBLIC_ORIGINS=https://harness.example.com
HGW_USAGE_TIME_ZONE=Asia/Shanghai
HGW_USERS_ROOT=/Users/ACCOUNT/harness-users
HGW_PROJECT_RUNTIMES_ROOT=/Users/ACCOUNT/harness-project-runtimes
HGW_PRINCIPAL_KEY_DIR=/Users/ACCOUNT/harness-gateway-data/principal-keys
HGW_RUNTIME_CREDENTIAL_DIR=/Users/ACCOUNT/harness-gateway-data/runtime-credentials
```

LaunchAgent 只使用稳定路径。替换 `ACCOUNT`，通过 `launchctl bootstrap` 加载 plist，并让隧道 upstream 继续指向 `http://127.0.0.1:8899`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.maycran.harness-gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/ACCOUNT/.local/libexec/harness-gateway/release-control.sh</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/ACCOUNT/harness-gateway-releases</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/ACCOUNT</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/Users/ACCOUNT/Library/Logs/harness-gateway.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/ACCOUNT/Library/Logs/harness-gateway.err.log</string>
</dict>
</plist>
```

完整构建 release 后，只通过控制器激活：

```sh
CONTROL="$HOME/.local/libexec/harness-gateway/release-control.sh"
RELEASE_NAME=coharness-REVISION
"$CONTROL" activate "$HOME/harness-gateway-releases/$RELEASE_NAME"
"$CONTROL" status
```

激活过程会校验产物、持有激活锁、原子替换 `current` 并重启 launchd；只有任务取得新 PID、cwd 指向目标 Gateway 目录且 `/healthz` 报告目标 release id 时，控制器才接受该 release。激活失败时，控制器会把 `current` 切回并验证上一个 release 后再返回错误。激活过程绝不删除 release；清理必须单独显式执行，并且只要目标是当前目录、活动 Gateway cwd、任一进程命令仍引用该目录，或目录下仍有打开的文件，控制器就会拒绝：

```sh
OLD_RELEASE_NAME=coharness-OLD-REVISION
"$CONTROL" prune "$HOME/harness-gateway-releases/$OLD_RELEASE_NAME"
```

请为 `HGW_PROJECT_RUNTIMES_ROOT`、`HGW_PRINCIPAL_KEY_DIR` 和 `HGW_RUNTIME_CREDENTIAL_DIR` 设置由 launchd 账户拥有的明确可写路径。管理员宿主机浏览器从 `/` 开始，已挂载外接磁盘显示在 `/Volumes` 下；请为进程授予所选目录需要的 macOS“隐私与安全性”文件访问权限，必要时包括“完全磁盘访问权限”。macOS 不存在内核目录约束，因此个人与共享项目进程依赖 directory-guard 插件和普通账户权限；该部署应视为受信团队形态。切流时停用旧的直连 LaunchAgent，防止 RunAtLoad 再次拉起它。

Gateway 启动在 PostgreSQL 暂时不可用时采用有界指数退避等待（`HGW_DATABASE_STARTUP_RETRY_INITIAL_MS` 与 `HGW_DATABASE_STARTUP_RETRY_MAX_MS`）。凭据错误、migration 校验和企业/节点未激活不会重试。PostgreSQL 容器保持 `unless-stopped` 策略；Docker Desktop 或主机恢复后执行 `docker compose up -d --wait`，Gateway 在数据库及所选企业/节点可用前必须保持未就绪。

## 升级与备份

升级 dsh：先在 Linux staging `npm install -g @deepseek-ai/dsh@<next>`，跑两个验收脚本和协作冒烟测试，然后逐个滚动生产运行时（`systemctl restart harness-<user>` / `systemctl restart harness-project-<id>`，或让闲置运行时在下次访问时使用新二进制）。Linux Gateway 升级会替换 `/srv/harness/gateway`、应用 PostgreSQL migration，再重启 `harness-gateway`；涉及协议或包变化时还要滚动重启运行时。macOS release 部署使用上面的控制器，使 Gateway 与本地运行时始终来自同一个不可变目录。数据库：把 `deploy/postgres/backup-postgres.sh` 挂进 cron，保留经过恢复校验的 dump，并把成功备份复制到第二台机器或 NAS。
