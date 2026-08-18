# Android 薄壳

[English](README.md) | 中文

这个目录是加载线上 Web UI 的 CoHarness Capacitor Android 壳。当前部署默认地址为 `https://harness.maycran.com/`；构建其他环境时可以用 `DSH_ANDROID_WEB_URL` 覆盖。

Android 应用 id 是 `com.coharness`。在 Firebase 及各 Android 厂商推送平台注册应用时必须使用这个 id。

## 首次初始化

```sh
cd apps/android-shell
pnpm install
DSH_ANDROID_WEB_URL=https://harness.maycran.com/ pnpm run build
pnpm run cap:add
DSH_ANDROID_WEB_URL=https://harness.maycran.com/ pnpm run cap:sync
```

启用 FCM 时，把 Firebase 控制台下载的 `google-services.json` 放到 `android/app/google-services.json`，不要提交服务端 Firebase service-account JSON。然后执行：

```sh
cd android
./gradlew assembleDebug
```

## 后续发布

普通 Web UI 修改只需要发布 Web 资源，不需要重新构建 APK。只有 Android 原生插件、权限、包名、图标或通知处理逻辑变化时才需要重新同步和构建 Android 工程。

自定义 CoHarness 桌面图标和启动画面的源文件保存在 `branding/`。Android 使用配套的自适应前景/背景资源、横竖屏启动画面，并把 `ic_stat_harness` 作为通知栏单色图标。

Gateway 需要配置 `HGW_FCM_PROJECT_ID` 和 `HGW_FCM_SERVICE_ACCOUNT_FILE` 才会实际向 FCM 发送消息。服务端凭据必须放在 Gateway 主机的权限受限文件中。

## 推送通道

原生 module 默认启用 JPush（`cn.jiguang.sdk:jpush:6.2.0`）。通过 Gradle 属性或环境变量设置 `JPUSH_APPKEY`；在 JPush 注册的 Android 包名必须是 `com.coharness`。薄壳只在 Android 通知权限获准后初始化 JPush，并在后续启动中记住该授权。Gateway 同时设置 `HGW_JPUSH_APP_KEY` 与 `HGW_JPUSH_MASTER_SECRET` 后才会发送 JPush 通知。只使用 JPush 的构建不需要 `google-services.json`。

可选厂商插件由 `JPUSH_ENABLE_HUAWEI`、`JPUSH_ENABLE_FCM`、`JPUSH_ENABLE_XIAOMI`、`JPUSH_ENABLE_OPPO`、`JPUSH_ENABLE_VIVO`、`JPUSH_ENABLE_MEIZU` 和 `JPUSH_ENABLE_HONOR` 控制。华为构建还需要 `android/app/agconnect-services.json`；FCM 构建需要 `android/app/google-services.json`。FCM 客户端默认使用 `25.1.1`，如果厂商兼容矩阵要求其他版本，可以通过 `FCM_MESSAGING_VERSION` 覆盖。AppKey、Secret、Firebase service-account JSON 和厂商配置文件都必须放在 Git 之外。
