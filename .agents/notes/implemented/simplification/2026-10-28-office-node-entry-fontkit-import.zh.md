# Agent Note: Office Node 入口的 fontkit 加载

Status: implemented

[English](2026-10-28-office-node-entry-fontkit-import.md) | 中文

## 问题

导入 Office 提供方会在文档需要转换之前加载 kit 的 Node API。kit 0.1.1 在这个入口保留了一条没有使用任何 fontkit 值的裸导入。短期字体 Worker 和转换 Worker 各自导入自己的解析器，因此这份额外模块图会占用 Host 进程的启动时间与内存。

在 macOS ARM64 上，两组交替的独立 plain-Node 进程导入已构建提供方耗时为 26.04 毫秒，省略该导入后为 5.19 毫秒。保留模块 namespace 引用且不强制 GC 时，对应导入窗口内 heap-used 增量为 7.97 MB 和 1.42 MB。这些小样本证明了一项启动优化候选，不能用来宣称转换提速或整个预览延迟改善。

## 决策

[限定版本的 pnpm 补丁](../../../../patches/@deepseek-ai__libreoffice-kit@0.1.1.patch)只删除 `@deepseek-ai/libreoffice-kit@0.1.1/lib/index.js` 中的 `import "fontkit";`。pnpm 的 `patchedDependencies` 和锁文件负责安装这项修改。两个 Worker 文件、解析器依赖、原生载荷、字体发现、缓存校验、转换限额与清理均保留原有实现。

[独立 kit 决策](../architecture/2026-09-14-independent-libreoffice-kit.zh.md)继续定义引擎与 API 发布职责；[共享字体元数据决策](../architecture/2026-10-26-local-runtime-office-font-metadata.zh.md)继续定义跨运行时的元数据复用。此补丁不增加引擎生命周期、字体缓存或 Session 授权所有者。上游包删除这条入口导入后，应用补丁可在完成同样验证后移除。

## 考虑过的替代方案

**异步检查元数据，只在缓存未命中后加载 fontkit。** 这会改变扫描及其所有调用方的执行方式，却没有证明转换提速。仅修改入口可保留原有扫描。

**从包依赖闭包中移除 fontkit。** 两个真实 Worker 均使用其解析器；省略依赖会破坏冷字体检查与字形匹配。

**为每个 Runtime 保留常驻引擎。** [字体元数据决策](../architecture/2026-10-26-local-runtime-office-font-metadata.zh.md)已否决空闲引擎的内存成本。启动模块加载无需保留引擎。

## 后果

新的提供方导入可避免主线程中未使用的解析器模块图。真实转换继续在两个 Worker 中加载 fontkit，并启动所选引擎。转换与浏览器就绪仍分别测量。

验证保留真实源读取、原生转换、PDF 字节和清理。私有空缓存与损坏缓存的原生 smoke 覆盖两个版本；模块求值观察确认两个 Worker 都保留解析器导入，主线程导入被移除。文本、页数与渲染像素按合成 fixture（测试前置数据）分别比较，不使用含有引擎元数据的 PDF 哈希作为相等依据。升级包时必须复核或移除这个精确版本补丁，不可静默沿用。
