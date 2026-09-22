# util/：底层共享工具

[English](README.md) | 中文

这些零依赖包提供由多个能力家族共享的小型原语。业务语义仍归各个消费这些原语的能力所有。

| 包 | 职责 |
|---|---|
| [`brand/`](brand/README.zh.md) | 提供带名义品牌的类型 |
| [`paths/`](home-paths/README.zh.md) | 解析 Harness 数据根目录和共享路径 |
| [`package-manifest/`](package-manifest/README.zh.md) | 插件 package manifest 的共享声明 |
| [`timeout/`](timeout/README.zh.md) | 提供截止时间和超时分类原语 |
| [`retention/`](output-retention/README.zh.md) | 限制保留文本和项集合的大小 |
| [`atomic-write/`](atomic-write/README.zh.md) | 以原子方式替换文件 |
| [`native-command/`](native-command/README.zh.md) | 不经 shell 运行宿主原生命令 |
| [`crypto/`](crypto/README.zh.md) | 生成浏览器安全 UUID 并编码字节 |


## 概述

`util/` 组为能力包提供共享的机制原语，避免重复实现。它涵盖原子写入、品牌化 id、双端队列、无损 JSON 值、UUID、Harness home 路径、启动环境、出站代理策略、原生命令、输出保留、时区规范化和超时处理。这里的每个根入口都是库：它不注册产品服务或事件，业务语义仍由消费它的能力负责。
