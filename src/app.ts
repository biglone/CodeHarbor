import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { MatrixChannel } from "./channels/matrix-channel";
import { ConfigService } from "./config-service";
import { AppConfig } from "./config";
import { CodexExecutor } from "./executor/codex-executor";
import { Logger } from "./logger";
import { Orchestrator } from "./orchestrator";
import { StateStore } from "./store/state-store";

const execFileAsync = promisify(execFile);

export class CodeHarborApp {
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly stateStore: StateStore;
  private readonly channel: MatrixChannel;
  private readonly orchestrator: Orchestrator;
  private readonly configService: ConfigService;

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
    this.configService = new ConfigService(this.stateStore, config.codexWorkdir);
    const executor = new CodexExecutor({
      bin: config.codexBin,
      model: config.codexModel,
      workdir: config.codexWorkdir,
      dangerousBypass: config.codexDangerousBypass,
      timeoutMs: config.codexExecTimeoutMs,
      sandboxMode: config.codexSandboxMode,
      approvalPolicy: config.codexApprovalPolicy,
      extraArgs: config.codexExtraArgs,
      extraEnv: config.codexExtraEnv,
    });

    this.channel = new MatrixChannel(config, this.logger);
    this.orchestrator = new Orchestrator(this.channel, executor, this.stateStore, this.logger, {
      progressUpdatesEnabled: config.matrixProgressUpdates,
      progressMinIntervalMs: config.matrixProgressMinIntervalMs,
      typingTimeoutMs: config.matrixTypingTimeoutMs,
      commandPrefix: config.matrixCommandPrefix,
      matrixUserId: config.matrixUserId,
      sessionActiveWindowMinutes: config.sessionActiveWindowMinutes,
      defaultGroupTriggerPolicy: config.defaultGroupTriggerPolicy,
      roomTriggerPolicies: config.roomTriggerPolicies,
      rateLimiterOptions: config.rateLimiter,
      cliCompat: config.cliCompat,
      configService: this.configService,
      defaultCodexWorkdir: config.codexWorkdir,
    });
  }

  async start(): Promise<void> {
    this.logger.info("CodeHarbor starting", {
      matrixHomeserver: this.config.matrixHomeserver,
      workdir: this.config.codexWorkdir,
      prefix: this.config.matrixCommandPrefix || "<none>",
    });
    await this.channel.start(this.orchestrator.handleMessage.bind(this.orchestrator));
    this.logger.info("CodeHarbor is running.");
  }

  async stop(): Promise<void> {
    this.logger.info("CodeHarbor stopping.");
    try {
      await this.channel.stop();
    } finally {
      await this.stateStore.flush();
    }
  }
}

export async function runDoctor(config: AppConfig): Promise<void> {
  const logger = new Logger(config.logLevel);
  logger.info("Doctor check started");

  try {
    const { stdout } = await execFileAsync(config.codexBin, ["--version"]);
    logger.info("codex available", { version: stdout.trim() });
  } catch (error) {
    logger.error("codex unavailable", error);
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
