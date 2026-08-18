# Android 薄壳

[English](README.md) | 中文

这个目录是加载线上 Web UI 的 CoHarness Capacitor Android 壳。当前部署默认地址为 `https://harness.maycran.com/`；构建其他环境时可以用 `DSH_ANDROID_WEB_URL` 覆盖。

## 首次初始化

```sh
cd apps/android-shell
pnpm install
DSH_ANDROID_WEB_URL=https://harness.maycran.com/ pnpm run build
pnpm run cap:add
DSH_ANDROID_WEB_URL=https://harness.maycran.com/ pnpm run cap:sync
```

把 Firebase 控制台下载的 `google-services.json` 放到 `android/app/google-services.json`，不要提交服务端 Firebase service-account JSON。然后执行：

```sh
cd android
./gradlew assembleDebug
```

## 后续发布

普通 Web UI 修改只需要发布 Web 资源，不需要重新构建 APK。只有 Android 原生插件、权限、包名、图标或通知处理逻辑变化时才需要重新同步和构建 Android 工程。

自定义 CoHarness 桌面图标和启动画面的源文件保存在 `branding/`。Android 使用配套的自适应前景/背景资源、横竖屏启动画面，并把 `ic_stat_harness` 作为通知栏单色图标。

Gateway 需要配置 `HGW_FCM_PROJECT_ID` 和 `HGW_FCM_SERVICE_ACCOUNT_FILE` 才会实际向 FCM 发送消息。服务端凭据必须放在 Gateway 主机的权限受限文件中。
