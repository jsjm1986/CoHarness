---
kind: upgrade-guide
description: 文档位置消费者从所属电脑解析已发布项目名称，不再使用治理库别名。
---

# 电脑所属的文档位置名称

[English](guide.md) | 中文

## 变更

`GET /account/api/document-locations` 使用 `metadataOnNode: true` 标记已发布项目位置。其 `name` 是 `#41` 等公开标识，不是项目名称。项目名称保留在所属电脑。旧位置继续直接返回名称。

Web 文档管理器通过 `GET /account/api/project-metadata?dshNode=<node>&ids=<project-ids>` 独立解析名称，每批最多 32 个项目。缓慢电脑保留编号，不阻塞其他位置。文档列表明确拒绝访问时，清空受影响视图并禁用写操作，直到当前的位置权限得到确认；临时失败保留原列表。

## 迁移

1. 部署配套的 Gateway 与 Web 客户端。自定义位置消费者解析显示名称时，必须固定 `scope.nodeId` 与项目 ID；不要把 `#41` 当作业务名称，也不要把项目名称保存到治理库。
2. 项目元数据请求保留账号认证和电脑地址。不要为了读取名称启动 Runtime，也不要把不可用电脑替换为本机。
3. 验证位置分页后的手机上传选择、两台电脑上的项目名称及拒绝访问后的操作状态。无需配置或存储数据迁移。参阅[文档管理器](../../../../packages/client/ui-documents/README.zh.md)。
