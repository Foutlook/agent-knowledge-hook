---
title: RPC 本地依赖索引
type: service-map
tags: [rpc, dependency, local-repository, facade]
scope: backend
services: [current-service, graph-service, catalog-service, record-service]
status: confirmed
updated: 2026-07-06
---

# RPC 本地依赖索引

## 类型

这是 `service-map` 类型知识，用来帮助 AI 和开发者在本地仓库中定位 RPC 接口实现、真实入参和最终调用点。

## 使用规则

- 先在当前项目中查 `@RpcReference`、实际入参和最终调用点。
- 再根据接口前缀到对应本地仓库和重点目录中查实现。
- 先确认数据源、过滤条件和返回字段赋值点，再考虑修改当前项目。
- 不要只凭接口名推断业务关系；跨服务结论必须回到真实调用链、Schema、查询或接口契约验证。

## 目录映射

| 接口前缀 | 本地仓库 | 重点目录 |
| --- | --- | --- |
| `com.example.graph.api.*` | `C:\workspace\graph-service` | `graph-api`、`graph-impl` |
| `com.example.catalog.client.api.*` | `C:\workspace\catalog-service` | `catalog-client`、`catalog-center`、`workflow-service`、`activity-service`、`issue-service` |
| `com.example.record.facade.api.*` | `C:\workspace\record-service` | `record-facade`、`catalog-center`、`issue-service` |
| `com.example.current.facade.*` | `C:\workspace\current-service` | `back/current-facade`、`back/current-common`、`back/current-app` |
| `com.example.identity.facade.*` / `com.example.guard.api.*` / `com.example.operation.api.*` / `com.example.area.facade.*` | 未检出源码 | 先补对应仓库再查 |

## 常用入口

- `queryEntityGraph`、实体图谱、实体归属：先看 `graph-service`。
- 目录状态、聚合榜单、权益道具、访问轨迹：先看 `catalog-service`。
- 操作记录、任务记录、异常清理：先看 `record-service`。
- 本项目自身 RPC 契约：先看 `back/current-facade`。

## 证据来源

- 来源文档：公开示例映射。
- 保留规则：先查 `@RpcReference`、实际入参和最终调用点，再进入本地依赖仓库核对实现。
- 使用边界：本文件是定位索引，不是业务结论本身；最终判断仍要以实际代码、接口契约、查询和返回字段赋值点为准。
