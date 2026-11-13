# Agent Note: PostgreSQL 登录准入忽略用户名大小写

Status: implemented

[English](2026-10-23-case-insensitive-login-admission.md) | 中文

## 问题

PostgreSQL 用户名和登录尝试计数采用忽略大小写的比较。若 advisory lock 的键保留同一用户名的不同拼写，不同 Gateway 就能并发统计失败次数，削弱共享的五次失败锁定规则。

## 决定

进程内登录队列和 PostgreSQL 事务锁都使用 PostgreSQL 按区域规则转换的小写用户名与组织身份。数据库查询在进入本地队列前计算该用户名。密码校验仍在事务外进行；加锁后的状态变化统计失败次数、重新验证当前身份和凭据，并提交登录尝试。

## 曾考虑的替代方案

**只使用进程内队列。** 不同 Gateway 进程不共享该队列，因此仍会基于同一 PostgreSQL 计数并发准入冲突的尝试。

**数据库锁保留提交时的拼写。** 忽略大小写的身份仍会落入不同的锁命名空间。

**两把锁都使用 JavaScript 小写转换。** JavaScript 与 PostgreSQL 的 Unicode 转换规则可能不同。数据库的区域规则可将 `clİent` 识别为 `client`，而 JavaScript 得到 `cli̇ent`；这些拼写会共享失败计数却使用不同的锁。

## 后果

不同大小写拼写在多个 Gateway 间共享一次锁定决策，包括 PostgreSQL 区域规则识别的别名。每次登录在密码验证前增加一次数据库查询；数据库失败时拒绝准入。[Gateway 按来源锁定登录](2026-11-13-per-source-login-lockout.zh.md) 把该计数限定在每个客户端来源内。真实 PostgreSQL 回归覆盖 ASCII 和依赖区域规则的别名，使用同一共享锁与失败计数。
