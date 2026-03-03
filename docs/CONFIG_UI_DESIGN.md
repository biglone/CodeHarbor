# CodeHarbor 配置管理 UI 设计（MVP）

## 1. 设计目标
在不破坏现有 Matrix + Codex 主流程前提下，提供可视化配置管理能力，优先解决：
- 并发与限流参数难以调优
- 房间策略配置门槛高
- 多项目场景下房间与工作目录映射缺失

## 2. 范围与边界

### 2.1 MVP 范围
- 全局运行配置编辑（限流、触发策略、兼容模式关键开关）
- 房间级配置（启用开关 + 触发策略 + `workdir` 映射）
- 配置校验与保存
- 健康检查面板（codex、Matrix、关键配置）
- 基础审计（最近配置变更列表）

### 2.2 非 MVP
- 完整 RBAC
- 组织级权限模型
- 多实例一致性协调
- 复杂审批流

## 3. 用户流程

### 3.1 管理员配置流程
1. 打开 UI（`codeharbor admin serve` 提供）
2. 进入“全局配置”页调整并发参数
3. 进入“房间配置”页设置某房间的触发策略与 `workdir`
4. 点击保存，后端校验并落盘
5. UI 返回“已生效/需重启”状态

### 3.2 运行时使用流程
1. Matrix 入站消息到 Orchestrator
2. 根据 roomId 读取房间策略与 workdir
3. 创建/复用会话并将任务路由到目标 workdir
4. 执行完成后回传房间

## 4. 信息架构
- `/` 概览页：版本、健康状态、最近错误
- `/settings/global` 全局配置
- `/settings/rooms` 房间配置列表
- `/settings/rooms/:roomId` 房间详情（策略+workdir）
- `/audit` 变更记录

## 5. 后端接口草案

### 5.1 配置读取
- `GET /api/admin/config/global`
- `GET /api/admin/config/rooms`
- `GET /api/admin/config/rooms/:roomId`

### 5.2 配置保存
- `PUT /api/admin/config/global`
- `PUT /api/admin/config/rooms/:roomId`

### 5.3 健康检查
- `GET /api/admin/health`

### 5.4 审计
- `GET /api/admin/audit?limit=50`

## 6. 数据模型建议

### 6.1 room_settings
```sql
CREATE TABLE IF NOT EXISTS room_settings (
  room_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  allow_mention INTEGER NOT NULL DEFAULT 1,
  allow_reply INTEGER NOT NULL DEFAULT 1,
  allow_active_window INTEGER NOT NULL DEFAULT 1,
  allow_prefix INTEGER NOT NULL DEFAULT 1,
  workdir TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 6.2 config_revisions
```sql
CREATE TABLE IF NOT EXISTS config_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

## 7. 配置生效策略
- 实时生效：房间触发策略、room-workdir 映射、限流阈值（新请求生效）
- 需重启：涉及进程启动参数或底层连接参数的变更
- UI 需明确提示每个字段的生效类型

## 8. 校验规则
- `workdir` 必须存在且可访问
- 并发参数必须为非负整数，且满足 `global >= per_user`、`global >= per_room`
- 房间策略字段为布尔值
- 禁止保存空 `room_id`

## 9. 安全与运维
- MVP 建议至少使用 `ADMIN_TOKEN` 保护管理接口
- 响应中敏感字段（token）默认脱敏
- 审计日志记录操作者、时间、摘要
- 保留配置导出/备份能力，支持故障回滚

## 10. 里程碑
- M1：配置存储与服务层
- M2：Orchestrator 接入 room-workdir
- M3：UI 页面与保存流程
- M4：测试、回归、发布文档

## 11. 开发前置检查
- 确认 `StateStore` 是否扩展为统一配置存储入口，或新增 `ConfigStore`
- 确认 UI 技术路线（原生静态页 / 轻前端框架）
- 确认管理端口与部署方式（仅本机/内网）

---
设计时间：2026-03-03 11:20:00 CST
