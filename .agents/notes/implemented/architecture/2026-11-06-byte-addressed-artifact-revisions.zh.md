# Agent Note：按字节寻址的产物 revision 与免钉选的不可变交付

Status: implemented

[English](2026-11-06-byte-addressed-artifact-revisions.md) | 中文

## 问题

两个属性使相同的 release 字节无法跨电脑共享缓存。其一，client 插件的 revision 由文件系统元数据派生——入口的 mtime、ctime 和大小——因此不同电脑上字节相同的产物得到不同的 revision；仅元数据变化的重写会重新发布一个未变的插件；仅修改 chunk 的编辑也只能经构建预设对 `client.js` 的标记间接推进 revision。revision 无法命名字节，携带它的 URL 也就不能保证在每个 Runtime 上命名相同的字节。其二，Gateway 对每个未钉选的浏览器资源请求都以追加了 `dshRuntime` 的 `302` 应答，浏览器与 CDN 缓存因此按 Runtime 分键：即使两个 Runtime 提供相同的字节，切换 Runtime 也要重新下载数 MB 的 combo，且首个请求还要付出一次重定向往返加一次远程节点跳转。不可变响应还以 identity 字节交付，因为 gzip 中间件逐请求重压缩且不产出 Brotli——对数 MB 的不可变 body 而言代价偏高。

## 决策

产物与 combo 的 revision 现在标识所供字节。`artifactRevision()` 对入口 bundle 连同按文件名排序的全部 `client*.js`／`client*.js.map` 同级文件求哈希，因此不同电脑上字节相同的产物得到相同的 revision，仅 chunk 或 map 变化也会独立推进 owner revision，且启动与 `rebuilt(id)` 共用同一推导。`rebuilt(id)` 保留元数据作为廉价探测：先比较入口的 mtime、ctime 和大小，只有出现差异才读取完整快照（tsdown 预设对 `client.js` 的完成标记正是让仅修改 chunk 的编辑体现为 stat 差异的机制）；字节哈希相同则保留已发布的 revision 且不改动图。过期 revision 与未知资源列表仍返回 404。

不可变 body 在 libuv 线程池上只压缩一次。`dsh-host-webserver` 导出 `precompressBody(identity, onError)`、`selectVariant(body, acceptEncoding)`、`acceptableEncodings` 与 `PrecompressedBody`：首次读取调度 Brotli（质量 9——在 11.5 MB 脚本语料上实测质量 10／11 约 4 秒／12 秒，质量 9 约 0.3 秒，收益甚微）与 gzip（level 1）变体；变体只在压缩完成后才进入变体表，`selectVariant` 为一个 `Accept-Encoding` 请求头选出已*就绪*的最佳编码——优先 Brotli，仍在压缩中的编码回落到已就绪编码或 identity。owner 自行设置 `content-encoding` 与 `vary: accept-encoding`；现有压缩中间件跳过已携带 `content-encoding` 的响应，两条路径不会叠加；失败的变体只记录日志，其余编码与 identity 继续提供服务。`dsh-client-modules` 把每个惰性 combo、chunk 与 map body 都包进该助手，并在 `bundleResource`——`fetchBundle()` 与 `/plugins` 路由共用——内逐请求协商；`dsh-host-frontend-static` 则按 mtime＋大小为每个带内容哈希的资产生成持有一份 `StaticBodyEntry`。HEAD 保持相同响应头且不物化 body。

Gateway 对字节确定性的浏览器 URL 改为就地转发而非钉选。在现有 Referer 块内，`resolveForAccount` 对来源页选定的 Runtime 完成授权后，`shareableImmutableRequest` 把指向带内容哈希 `/assets/*` 路径、携带 `rev` 的 `combo.js??` URL、或带 `rev` 的 `client.*.js` chunk 及 map 的 GET 或 HEAD 归类为字节确定性；请求 URL 内部钉选 `dshRuntime` 后落入常规选定 Runtime 管线——远程经现有 `nodeServiceProxy.http()` 转发、本地直接提供——不引入第二条传输，浏览器 URL 也不出现钉选。Runtime 专属或未带 revision 的路径（`/plugins/events`、`/favicon.svg`、无 revision 的插件或资源 URL）以及所有非 GET／HEAD 方法保持 302 重定向。资源谓词镜像自 `dsh-host-frontend-static` 的 `IMMUTABLE_ASSET_PATH`，chunk 形式镜像自 `dsh-client-modules` 的 `CLIENT_CHUNK`，两侧都带对齐注释。combo 路径的 `combo.js` 文件名继续让它落入 CDN 静态扩展名缓存（见 [combo 路由笔记](2026-10-20-combo-route-static-extension.zh.md)），加载模型笔记中的 revision 机制已在 [client 插件加载笔记](2026-07-23-client-plugin-loading-model.zh.md) 中就地更新。

## 已考虑的替代方案

**保留 302 钉选、按 Runtime 分键缓存。** 否决：每次切换 Runtime 都重新下载相同的 combo 字节，每个首个请求都付出一次重定向加一次远程跳转——这正是本次消除的成本。

**只对入口 bundle 求哈希。** 否决：仅修改 chunk 的编辑会保留已发布的 revision，被保留的 URL 将提供其 revision 不再描述的字节——同级文件集合必须计入哈希。

**经现有逐请求 gzip 中间件压缩。** 否决：它会对相同的不可变数 MB 逐请求重压缩，且无法产出 Brotli；后台变体按 body 摊销一次并解锁更好的编码。

**Brotli 质量 10 或 11。** 由 11.5 MB 语料实测否决：质量 9 约 0.3 秒、质量 10 约 4 秒、质量 11 约 12 秒，相对质量 9 最多再省约 10%——质量 9 留在后台预算内，更高档不行。

**跨包边界共享一个导出的资源谓词。** 否决：Gateway 是独立部署体，不引入 `dsh-host-*` 包，因此两侧各保留一份镜像正则并对齐注释；`CLIENT_CHUNK` 形式同理。

## 结果

带 revision 的 combo 或 chunk URL 在每个运行相同产物的电脑上命名相同的字节，浏览器与 CDN 因此跨 Runtime 共享同一份缓存条目，切换 Runtime 不再重复下载相同 bundle；首个请求仍在任何转发之前完成来源页 Runtime 授权，未授权请求在不接触节点的情况下被拒绝。字节相同的重写——包括 Host 在不变产物上重启——保留其已发布 revision，SSE 重连不会替换浏览器插件；stat 无法感知的内容变化也不再可能藏进已保留的 revision。Brotli 变体就绪后比 gzip 再小约三成，且已携带 `content-encoding` 的响应永不会被二次压缩。代价是每次 stat 探测到的重建都要完整读取产物并求哈希——由原本就过滤 HMR 轮询的同一 stat 门槛约束——每个新物化的不可变 body 两个后台 zlib 任务，每个缓存响应保留一份变体集合，以及每个共享缓存都必须按 `vary: accept-encoding` 分键。

## 测试

`packages/client/modules/tests/node-half.client.spec.ts` 固定按字节派生的 revision（相同产物共享 URL、仅修改 chunk 的编辑推进 revision）、bundle 路由上的 Accept-Encoding 协商，以及过期 revision 与非法包列表的 404。`packages/host/frontend-static/tests/frontend-static.spec.ts` 证明不可变缓存头、`vary`、Brotli 就绪后的优先与 gzip 回退。`packages/host/webserver/tests/webserver.spec.ts` 证明已携带 `content-encoding` 的响应不会被二次压缩。`gateway/tests/node-service.spec.ts` 与 `gateway/tests/server.spec.ts` 固定带 revision 的 combo／chunk／map 与带哈希资源路径的直接转发、`/plugins/events` 及无 revision 路径保持重定向，以及授权失败时在转发前拒绝。
