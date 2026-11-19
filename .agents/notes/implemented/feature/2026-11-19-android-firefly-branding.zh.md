# Agent Note: Android 启动器图标与启动画面改用萤火虫品牌标识

Status: implemented

[English](2026-11-19-android-firefly-branding.md) | 中文

## Problem

Android shell 的启动器图标与启动画面此前使用的是一个为 shell 临时发明的电路六边形标记，并非产品真实 logo。它与项目实际使用的两个标识——`website/public/favicon.svg` 的萤火虫和 `apps/web/public/favicon.svg` 的简单弧点标记——都没有关联，安装后的应用在外观上没有品牌识别度。

## Decision

`apps/android-shell/branding/` 现在以萤火虫标记作为启动器与启动画面素材的唯一来源。三份图标 SVG(`app-icon.svg`、`app-icon-round.svg`、`app-icon-foreground.svg`）保留既有的藏青渐变、四角电路装饰与 adaptive icon 分层，但中心换成按暗色方案固化的萤火虫图形：favicon 的明暗媒体查询被压平为暗色调色板，触角描边从 1.9 加粗到 2.8 以保证 mdpi 栅格化后仍可辨认，中心辉光由青色改为与萤火呼应的蓝（`#4F7CFF`)。两份 splash SVG 用同一图形替换原六边形组合。`android/app/src/main/res/` 下 26 张 PNG 已按新源重渲染（5 个启动器密度 × 图标/圆图标/前景，11 张启动画面尺寸），并已进入 debug APK——在 `app-debug.apk` 的 `res/mipmap-xxxhdpi-v4/` 中验证过。

图标由两层资源承载，必须保持同步：`mipmap-*` PNG 服务 API 26 以下兜底与商店展示，而 API 26+ 启动器走 `mipmap-anydpi-v26/ic_launcher.xml` → `@drawable/ic_launcher_foreground` → `drawable-v24/ic_launcher_foreground.xml` 这个 **vector drawable**。该矢量内是手工转换为 `pathData` 的同一萤火虫图形（64 单位字形空间，`translate(19.93 23.11) scale(1.1074)` 映射进 108dp 视口）；只更新栅格前景会让现代设备仍显示旧标记。

## Alternatives considered

- **简单弧点标记**(`apps/web/public/favicon.svg`)：在辨识度上输给萤火虫——48dp 下它读作一个与其他任何界面都不共享的通用图形，而萤火虫已是文档站的品牌标识且缩小后仍可辨认。
- **原样嵌入 favicon**：否决，因为它的 `prefers-color-scheme` 媒体查询在静态栅格化场景下无法解析颜色，且 1.9 单位的触角在 mdpi 会抖动消失；固化暗色变体加粗描边后是同一个标记，只是可渲染。
- **仅启动画面保留六边形**：否决，出于一致性——六边形 splash 叠加萤火虫图标的混合识别比任一单选更差。

## Consequences

启动器与启动画面现在与文档站使用同一品牌标记。接受的代价：萤火虫细翅膀描边与点缀小圆点在 mdpi(48px）下会损失一些细节，由加粗触角与高对比身体/翅膀填充补偿。release 签名 APK 仍未配置；本次改动只影响可 debug 构建的素材。

## Verification

- `./gradlew :app:assembleDebug :app:lintDebug :app:testDebugUnitTest :app:assembleDebugAndroidTest` —— 在 JDK 21 上 BUILD SUCCESSFUL。
- 对 `app-debug.apk` 运行 `aapt2 dump badging` 确认包名 `com.coharness`；包内 `res/mipmap-xxxhdpi-v4/ic_launcher.png` 渲染为藏青圆角底上的萤火虫图形。
- `aapt2 dump xmltree app-debug.apk --file res/drawable-v24/ic_launcher_foreground.xml` 确认编译进包的 adaptive icon 前景携带萤火虫 `pathData` 组（`scaleX=1.1074`、`translateX=19.93`)。
