# AutoDev 灰度发布与回滚清单（T10.14）

## 1. 目标

为阶段 10 重构后的 AutoDev 提供可执行的分批启用与回滚流程，降低一次性全量上线风险。

## 2. 灰度发布清单（按模块分批）

### Phase 0：发布前基线

- 确认版本与变更范围：`git log --oneline -n 20`
- 校验 Changelog：`npm run changelog:check`
- 校验版本递进（不跳版本）：
  - `TARGET_VERSION=$(node -p "require('./package.json').version")`
  - `LATEST_VERSION=$(npm view codeharbor version)`
  - `TARGET_VERSION=$TARGET_VERSION LATEST_VERSION=$LATEST_VERSION node scripts/check-release-version-progression.mjs`

通过标准：全部命令成功。

### Phase 1：控制面（Control）灰度

涉及模块：

- `src/workflow/autodev.ts`
- `src/orchestrator/autodev-control-parser.ts`
- `src/orchestrator/autodev-command-handler-registry.ts`
- `src/orchestrator/autodev-control-response.ts`

灰度方式：

- 先在 canary 会话/房间验证 `status/run/stop/progress/content`。
- 验证通过后再开放到主房间。

验收检查：

- `//autodev status`
- `//autodev progress status`
- `//autodev content status`
- `//diag autodev 5`

### Phase 2：策略面（Policy）灰度

涉及模块：

- `src/orchestrator/autodev-completion-gate-policy.ts`
- `src/orchestrator/autodev-validation-policy.ts`
- `src/orchestrator/autodev-status-heal-policy.ts`

灰度方式：

- 先在 canary 会话跑 1~2 个真实任务，观察 gate 与 validation 输出。
- 再逐步放量到常用项目。

验收检查：

- `//autodev run <taskId>` 后确认 `completionGate` 与 `validation` 字段
- `//autodev status` 确认 `runValidationFailureClass/runValidationEvidenceSource`
- 必要时执行 `//autodev reconcile`

### Phase 3：集成面（Runner + Release/Handoff）灰度

涉及模块：

- `src/orchestrator/autodev-stage-executor.ts`
- `src/orchestrator/autodev-result-reporter.ts`
- `src/orchestrator/autodev-release.ts`
- `src/orchestrator/autodev-run-archive.ts`

建议开关策略：

- 先保持 `AUTODEV_AUTO_RELEASE_ENABLED=false`
- 先验证 secondary review handoff（如启用）：
  - `AUTODEV_SECONDARY_REVIEW_ENABLED=true`
  - `AUTODEV_SECONDARY_REVIEW_TARGET=@review-guard`
- handoff 稳定后，再启用：`AUTODEV_AUTO_RELEASE_ENABLED=true`

验收检查：

- 任务完成时是否出现 `AutoDev secondary review handoff` 回显
- 发布映射命中后是否生成 `release: vX.Y.Z [publish-npm]` 提交
- run archive 是否落盘（若启用归档）

## 3. 回滚清单（按优先级）

### R1：先止血（不改代码）

- 暂停后续循环：`//autodev stop`
- 降级风险开关：
  - `AUTODEV_AUTO_RELEASE_ENABLED=false`
  - `AUTODEV_SECONDARY_REVIEW_ENABLED=false`
  - `AUTODEV_VALIDATION_STRICT=false`（仅在严格校验导致误阻断时）
- 必要时将 `AUTODEV_LOOP_MAX_RUNS` 临时设为 `1`，限制单次影响面

### R2：状态收敛

- 对账修复：`//autodev reconcile`
- 检查最近轨迹：`//diag autodev 10`
- 确认无卡死任务（`🔄`）后再恢复流量

### R3：代码回滚

- 回退到上一个稳定提交（建议按 T10 提交粒度回退）
- 重新部署并重启服务
- 回归验证：`//autodev status` + canary 任务 smoke

## 4. 首版发布演练记录（2026-04-06）

执行结果：通过。

已执行命令与结果摘要：

1. `npx vitest run test/autodev-control-command.test.ts test/autodev-policy-contract.test.ts test/autodev-runner.test.ts`
   - 结果：`3 passed (16 tests)`
2. `npm run changelog:check`
   - 结果：`OK: CHANGELOG.md contains entry for 0.1.95`
3. `TARGET_VERSION=0.1.95 LATEST_VERSION=0.1.95 node scripts/check-release-version-progression.mjs`
   - 结果：目标版本等于 npm latest，允许发布流程按“重复版本跳过发布”策略继续执行

结论：

- 阶段 10 控制/策略/集成链路具备灰度发布条件
- 具备可执行回滚路径（开关止血 + 状态收敛 + 提交级回退）
