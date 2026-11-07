# Agent Note:登出撤销等待续期行锁而不是失败

状态:已实现

[English](2026-11-07-logout-revoke-lock-contention.md) | 中文

## 问题

每个浏览器请求都在 `validateSession()` 内续期会话,对会话行加 `FOR UPDATE`。而 `revoke()` 更新同一行时没有任何容错:当续期持锁超过连接池 `lock_timeout`,PostgreSQL 以 `55P03` 取消该更新,`/logout` 返回 500。生产环境复现为完整登出失败——页面渲染 `internal error`,而并发扇出仍在持续续期同一行。

## 决定

[PostgresAuthService.revoke()](../../../../gateway/src/postgres/auth-service.ts) 只对 `55P03` 重试,最多四次尝试、250ms 递增退避,其它错误原样抛出。登出语义不变:同一条单语句更新、同一个 `revoked_reason='logout'` 标记、同一个 WHERE 子句——锁等待是时序属性而非授权决定,所以等待短暂续期结束是正确解法,而不是报错或削弱更新。

## 备选方案

**NOWAIT + 客户端重试。** 把竞争以错误形式暴露给浏览器,而浏览器无法有意义地处理;服务端重试严格更优,因为持锁时间被一条续期语句约束。

**重试所有错误。** 已撤销、过期或已删除的行应得到真实错误;掩盖非锁失败会把真正的 bug 藏在重复尝试之后。

## 影响

竞争的登出在续期释放行后完成,最多约 1.5 秒延迟。撑过四次尝试的续期仍会暴露 55P03——病态竞争下这是诚实答案。回归 spec 用 `FOR UPDATE` 持锁会话行,在重试中途提交,断言 `revoked_reason='logout'` 落库(gateway/tests/auth-postgres.spec.ts)。
