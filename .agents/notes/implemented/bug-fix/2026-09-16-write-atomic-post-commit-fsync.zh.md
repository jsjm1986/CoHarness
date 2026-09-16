# Agent Note：提交点后的 fsync 失败不算写入失败

状态：implemented

[English](2026-09-16-write-atomic-post-commit-fsync.md) | 中文

## 问题

`writeAtomic` 把 `rename` 之后的 `fsync` 失败与提交点之前的错误同等处理：清理临时文件（此时已被 rename 走）并重新抛出，调用方于是把内存状态回滚到旧值，而磁盘上的文件已是新内容——介质与内存分叉。

## 决策

`rename` 之后的父目录 `fsync` 是 best-effort：rename 已经提交了新内容，因此失败被容忍并让写入返回成功。只有提交点之前的错误会拒绝写入；该 helper 是无诊断通道的叶子工具，被吞掉的失败在 `catch` 处注明。

## 考虑过的替代方案

**照常传播 fsync 失败。** 否决：调用方无法据此行动——磁盘已是新内容时回滚内存，比接受已提交的写入严格更差。

**删除新文件以恢复旧状态。** 否决：旧值已被 rename 替换、不复存在，"恢复"需要重写一遍，并给恢复路径引入第二种失败模式。

## 后果

持久但 fsync 失败的写入报告成功，与磁盘真实状态一致；持久性减弱的信号只留在 `catch` 注释里，因为 `writeAtomic` 没有可上报的 logger。

## 验证

`json-backend.spec.ts` 覆盖两侧分界：提交点前失败拒绝并回滚，rename 后的 fsync 失败记 warning 且后端保留已提交状态。
