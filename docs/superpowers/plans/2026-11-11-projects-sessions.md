# 方案与会话实施记录

| 项 | 值 |
|---|---|
| 文档时间 | 2026-11-11 13:45:01 +0800 |
| 状态 | 已完成，提交 `750b4ff` |
| 行为细则 | `docs/superpowers/specs/2026-11-04-enterprise-harness-platform-design.md` 第 6 节 |
| 核对 | 2026-11-11 13:44:20 全量测试 16 个文件、29 个测试通过 |

本阶段只做项目、会话、草稿、菜单和授权。不编译项目服务，不生成项目镜像，不发布到测试区或正式区，也不调用真实模型。

## 已实现行为

- 中文项目名经 `pinyin-pro` 生成编码。`请假审批` 为 `qing-jia-shen-pi`，`OA系统` 为 `oa-xi-tong`。无法生成时返回 `无法生成项目编码`。
- 自动编码冲突时追加 `-2`。调用方自己提交的编码冲突时返回 `项目编码已存在`。
- 新建项目默认使用同名容器组。创建人成为项目负责人。平台管理员可以创建；其他人需要 `create_project` 权限，否则返回 `没有创建项目的权限`。
- 同一项目的草稿对项目成员共享。每个用户有自己的需求会话，不能读取其他人的消息。
- 直接授权和角色授权取并集。项目负责人不能修改自己不负责的项目，返回 `没有项目管理权限`。
- 确认方案只写入 OpenSpec 变更的新增、修改、删除。已发布菜单保持为空，业务导航不出现草稿菜单。
- 模型未配置时，发送需求返回 `会话和运维智能体不会调用模型`，门户输入框不可发送。
- `run_tests` 在没有候选镜像时返回 `还没有候选镜像`。`replay_test` 在记录不存在时返回 `没有这条测试记录`。

## 代码位置

- `platform/apps/control-plane/src/project-code.ts`
- `platform/apps/control-plane/src/projects.ts`
- `platform/apps/control-plane/src/drafts.ts`
- `platform/apps/control-plane/src/schema.sql`
- `platform/apps/control-plane/src/server.ts`
- `platform/apps/portal/src/App.tsx`
