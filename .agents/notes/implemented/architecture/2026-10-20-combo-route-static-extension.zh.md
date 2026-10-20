# Agent Note：combo 路由携带静态扩展名文件名以进入 CDN 边缘缓存

Status: implemented

[English](2026-10-20-combo-route-static-extension.md) | 中文

## 问题

插件 bundle 路由原本是 `/plugins/??<resources>&rev=<rev>`——`??` 直接开启查询串，因此路径中没有文件名、没有扩展名。Cloudflare 等 CDN 按路径扩展名决定默认可缓存响应，于是每次打开页面都要把数 MB 的不可变 combo 从源站隧道完整拉一遍，尽管响应声明了 `public, max-age=31536000, immutable`。`/plugins/<package>/<file>.js` 形式的 chunk URL 本就带扩展名，已被边缘缓存。

## 决策

combo 路径携带一个合成文件名 `combo.js`：`/plugins/combo.js??<resources>&rev=<rev>`。该文件名只为 CDN 静态扩展名规则存在，不对应任何真实文件；map 变体共用此文件名，使脚本内相对的 `sourceMappingURL` 尾注仍解析到同一绝对键。服务端按 `pathname + search` 查键，路由、revision 校验与分区逻辑不变。客户端 `chunkUrl` 解析器剥掉这个合成段——同级 chunk 仍在 `/plugins/<package>/` 下。

## 已考虑的替代方案

**为 `/plugins/*` 配 CDN 缓存规则。** 否决：配置在仓库之外，每个部署、每家 CDN 都要重配，且 zone 配置漂移时会静默回退。

**缓存键改写或 Worker。** 否决：用企业版机制去弥补一个源站自己就能决定的路径名。

## 影响

首次加载仍付源站路径成本；重复加载与同边缘的所有访问者改由缓存响应。边缘缓存的响应不再经过源站会话门——`/assets/*` 构建产物早已处于同一姿态；负载仍是按内容 revision 键控的不可变、非个性化 bundle。未知资源列表或陈旧 revision 的请求仍回源站 404。
