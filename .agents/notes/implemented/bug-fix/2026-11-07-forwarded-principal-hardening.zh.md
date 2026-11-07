# Agent Note: 转发 principal 验证改为失败收敛且廉价

Status: implemented

[English](2026-11-07-forwarded-principal-hardening.md) | 中文

## Problem

`x-dsh-gateway-forward` 由客户端可设置,而其验证在会话校验之前运行。三个缺口把畸形或不可解析的断言变成了普通请求的代价或故障:`forwardIssuerOf` 返回任何非空字符串,`issuerNode: "junk"` 的载荷会抵达 `uuid` 类型的目录查询并抛出 `22P02`,造成每请求一次的未认证 500;验证内部的目录或数据库故障同样向上传播;合法但未知的 issuer 从不被记忆化,每个请求都付出一次新的数据库读。

## Decision

畸形 issuer 不再到达目录:[forwardIssuerOf](../../../../gateway/src/forwarded-principal.ts) 现在要求 issuer 满足 `nodeUuidSchema` 才返回,非节点值走普通会话路径,不再暴露数据库类型错误。[forwardedPrincipal](../../../../gateway/src/index.ts) 接线把任何抛出的错误按断言缺席处理并返回 null,让设计上回退会话校验的语义覆盖全部失败形态而非仅干净的 null。[NodePrincipalDirectory](../../../../gateway/src/postgres/node-principal-directory.ts) 以与密钥相同的 TTL 记忆化否定判决——未知 issuer 的声明每 TTL 只花一次读,登记仍通过访问监视器的 `invalidate()` 清除条目。

## Alternatives considered

**只在目录层校验形态。** 调用点是每条转发必经的唯一位置;在那里包容错误可覆盖本变更尚未想到的目录缺陷,而形态闸门让明显畸形的输入完全不触线。

**不做负缓存。** 每个未认证请求将永远付出一次数据库读;缓存与密钥共用同一 TTL 上界,并随同一监视器事件失效。

## Consequences

畸形或不可解析的转发头退化为普通会话校验请求而非错误响应。转发路径的认证前成本为每 issuer 每 TTL 一次缓存读。窗口内被禁用的用户仍在断言 TTL 内被认可——该记录在案的粒度取舍不变。
