# Agent Note: 为每个 profile 组装推导已发布 preset 根目录

Status: implemented

[English](2026-08-29-derived-shipped-preset-root.md) | 中文

## 问题

CLI 拥有安装目录中的 preset，而 profile 与 home patch 层拥有 agent-presets 行。启动器注入的根目录如果替换用户配置，可能丢失已配置的根，或在热更新后保持过期。

## 决策

启动器先组装 bundle、profile、home 和 overlay 的全部行，再推导 agent-presets patch：在字面量配置的 roots 前置已安装的系统根，同时保留其他所有配置字段。配置 dump 和每次 live patch generation 都执行相同推导。缺少 roster 行时保持不变；动态配置表达式或非数组 roots 会明确失败，因为启动器无法安全重写。

## 备选方案

**用唯一的安装根替换整行。** 不予采用：部署可能有意加入组织或用户 preset 根。

**把安装根写入 web bundle patch。** 不予采用：source 与 built CLI 的锚点不同，且 live 用户层修改无法一致生效。

**只在启动时推导一次。** 不予采用：profile 与 home patch 热更新必须更新有效根，不能保留过期组装。

## 影响

已发布 preset 始终可用并具有确定的系统优先级，同时保留配置根与其他标志。配置 dump 现在显示启动器推导层，错误的动态 roster 配置会报告可操作的加载错误。

## 测试

CLI 测试覆盖根目录前置与字段保留、缺少行、错误 roots 和组装顺序；已发布 shell 与 preset 组装测试继续使用真实 bundle 层。
