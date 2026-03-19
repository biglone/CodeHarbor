import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AdminServer } from "./admin-server";
import { ApiServer } from "./api-server";
import { type Channel } from "./channels/channel";
import { MatrixChannel } from "./channels/matrix-channel";
import { ConfigService } from "./config-service";
import { AppConfig } from "./config";
import { CodexExecutor } from "./executor/codex-executor";
import { HistoryService } from "./history-service";
import { Logger } from "./logger";
import { Orchestrator } from "./orchestrator";
import { NpmRegistryUpdateChecker, resolvePackageVersion } from "./package-update-checker";
import { StateStore } from "./store/state-store";

const execFileAsync = promisify(execFile);
const DEFAULT_WORKFLOW_EXEC_TIMEOUT_MS = 30 * 60 * 1_000;

export class CodeHarborApp {
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly stateStore: StateStore;
  private readonly historyService: HistoryService;
  private readonly channel: Channel;
  private readonly orchestrator: Orchestrator;
  private readonly configService: ConfigService;
  private readonly apiServer: ApiServer | null;

  constructor(config: AppConfig) {
    this.config = config;
    this.logger = new Logger(config.logLevel);

    this.stateStore = new StateStore(
      config.stateDbPath,
      config.legacyStateJsonPath,
      config.maxProcessedEventsPerSession,
      config.maxSessionAgeDays,
      config.maxSessions,
    );
    this.historyService = new HistoryService(this.stateStore, this.logger, {
      cleanupOwner: `main:${process.pid}`,
    });
    this.configService = new ConfigService(this.stateStore, config.codexWorkdir);
    const buildExecutor = (provider: "codex" | "claude"): CodexExecutor =>
      new CodexExecutor({
        provider,
        bin: resolveProviderBin(config, provider),
        model: config.codexModel,
        workdir: config.codexWorkdir,
        dangerousBypass: config.codexDangerousBypass,
        timeoutMs: config.codexExecTimeoutMs,
        sandboxMode: config.codexSandboxMode,
        approvalPolicy: config.codexApprovalPolicy,
        extraArgs: config.codexExtraArgs,
        extraEnv: config.codexExtraEnv,
      });
    const executor = buildExecutor(config.aiCliProvider);
    const workflowExecTimeoutMs = Math.max(config.codexExecTimeoutMs, DEFAULT_WORKFLOW_EXEC_TIMEOUT_MS);

    this.channel = new MatrixChannel(config, this.logger);
    const packageVersion = resolvePackageVersion();
    this.orchestrator = new Orchestrator(this.channel, executor, this.stateStore, this.logger, {
      progressUpdatesEnabled: config.matrixProgressUpdates,
      progressMinIntervalMs: config.matrixProgressMinIntervalMs,
      typingTimeoutMs: config.matrixTypingTimeoutMs,
      commandPrefix: config.matrixCommandPrefix,
      matrixUserId: config.matrixUserId,
      sessionActiveWindowMinutes: config.sessionActiveWindowMinutes,
      groupDirectModeEnabled: config.groupDirectModeEnabled,
      defaultGroupTriggerPolicy: config.defaultGroupTriggerPolicy,
      roomTriggerPolicies: config.roomTriggerPolicies,
      rateLimiterOptions: config.rateLimiter,
      cliCompat: config.cliCompat,
      multiAgentWorkflow: {
        ...config.agentWorkflow,
        executionTimeoutMs: workflowExecTimeoutMs,
      },
      packageUpdateChecker: new NpmRegistryUpdateChecker({
        packageName: "codeharbor",
        currentVersion: packageVersion,
        enabled: config.updateCheck.enabled,
        timeoutMs: config.updateCheck.timeoutMs,
        ttlMs: config.updateCheck.ttlMs,
      }),
      updateCheckTtlMs: config.updateCheck.ttlMs,
      configService: this.configService,
      defaultCodexWorkdir: config.codexWorkdir,
      aiCliProvider: config.aiCliProvider,
      aiCliModel: config.codexModel,
      matrixAdminUsers: config.matrixAdminUsers,
      upgradeAllowedUsers: config.matrixUpgradeAllowedUsers,
      executorFactory: buildExecutor,
    });
    this.apiServer =
      config.apiEnabled && config.apiToken
        ? new ApiServer(this.logger, this.orchestrator, {
            host: config.apiBindHost,
            port: config.apiPort,
            apiToken: config.apiToken,
            webhookSecret: config.apiWebhookSecret,
            webhookTimestampToleranceSeconds: config.apiWebhookTimestampToleranceSeconds,
          })
        : null;
  }

  async start(): Promise<void> {
    this.logger.info("CodeHarbor starting", {
      matrixHomeserver: this.config.matrixHomeserver,
      workdir: this.config.codexWorkdir,
      provider: this.config.aiCliProvider,
      prefix: this.config.matrixCommandPrefix || "<none>",
    });
    this.historyService.startCleanupScheduler();
    await this.channel.start(this.orchestrator.handleMessage.bind(this.orchestrator));
    await this.orchestrator.bootstrapTaskQueueRecovery();
    if (this.apiServer) {
      await this.apiServer.start();
      const address = this.apiServer.getAddress();
      this.logger.info("CodeHarbor task API server started", {
        host: address?.host ?? this.config.apiBindHost,
        port: address?.port ?? this.config.apiPort,
      });
    }
    this.logger.info("CodeHarbor is running.");
  }

  async stop(): Promise<void> {
    this.logger.info("CodeHarbor stopping.");
    this.historyService.stopCleanupScheduler();
    let firstError: unknown = null;
    try {
      await this.apiServer?.stop();
    } catch (error) {
      firstError = error;
      this.logger.error("Failed to stop task API server", error);
    }
    try {
      await this.channel.stop();
    } catch (error) {
      if (!firstError) {
        firstError = error;
      } else {
        this.logger.error("Failed to stop channel", error);
      }
    } finally {
      await this.stateStore.flush();
    }
    if (firstError) {
      throw firstError;
    }
  }
}

export class CodeHarborAdminApp {
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly stateStore: StateStore;
  private readonly historyService: HistoryService;
  private readonly configService: ConfigService;
  private readonly adminServer: AdminServer;

  constructor(config: AppConfig, options?: { host?: string; port?: number }) {
    this.config = config;
    this.logger = new Logger(config.logLevel);
    this.stateStore = new StateStore(
      config.stateDbPath,
      config.legacyStateJsonPath,
      config.maxProcessedEventsPerSession,
      config.maxSessionAgeDays,
      config.maxSessions,
    );
    this.historyService = new HistoryService(this.stateStore, this.logger, {
      cleanupOwner: `admin:${process.pid}`,
    });
    this.configService = new ConfigService(this.stateStore, config.codexWorkdir);
    this.adminServer = new AdminServer(config, this.logger, this.stateStore, this.configService, {
      host: options?.host ?? config.adminBindHost,
      port: options?.port ?? config.adminPort,
      adminToken: config.adminToken,
      adminTokens: config.adminTokens,
      adminIpAllowlist: config.adminIpAllowlist,
      adminAllowedOrigins: config.adminAllowedOrigins,
      historyService: this.historyService,
    });
  }

  async start(): Promise<void> {
    await this.adminServer.start();
    this.historyService.startCleanupScheduler();
    const address = this.adminServer.getAddress();
    this.logger.info("CodeHarbor admin server started", {
      host: address?.host ?? this.config.adminBindHost,
      port: address?.port ?? this.config.adminPort,
      tokenProtected: Boolean(this.config.adminToken) || this.config.adminTokens.length > 0,
    });
  }

  async stop(): Promise<void> {
    this.logger.info("CodeHarbor admin server stopping.");
    this.historyService.stopCleanupScheduler();
    try {
      await this.adminServer.stop();
    } finally {
      await this.stateStore.flush();
    }
  }
}

export async function runDoctor(config: AppConfig): Promise<void> {
  const logger = new Logger(config.logLevel);
  logger.info("Doctor check started");
  const cliLabel = config.aiCliProvider === "claude" ? "claude code" : "codex";

  try {
    const { stdout } = await execFileAsync(config.codexBin, ["--version"]);
    logger.info("ai cli available", { provider: config.aiCliProvider, cli: cliLabel, version: stdout.trim() });
  } catch (error) {
    logger.error("ai cli unavailable", error);
    throw error;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.doctorHttpTimeoutMs);
    timer.unref?.();

    const response = await fetch(`${config.matrixHomeserver}/_matrix/client/versions`, {
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(timer);
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = (await response.json()) as { versions?: string[] };
    logger.info("matrix reachable", { versions: body.versions ?? [] });
  } catch (error) {
    logger.error("matrix unreachable", error);
    throw error;
  }

  logger.info("Doctor check passed");
}

function resolveProviderBin(config: AppConfig, provider: "codex" | "claude"): string {
  if (provider === config.aiCliProvider) {
    return config.codexBin;
  }
  return provider === "claude" ? "claude" : "codex";
}
