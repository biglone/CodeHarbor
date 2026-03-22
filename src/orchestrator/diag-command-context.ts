import type { BackendModelRouteProfile } from "../routing/backend-model-router";
import type { AutoDevRunSnapshot } from "./autodev-runner";
import { sendDiagCommand as runSendDiagCommand } from "./diag-command-dispatch";
import type { SessionBackendDecision, SessionBackendOverride } from "./orchestrator-types";
import { createIdleAutoDevSnapshot } from "./autodev-snapshot";

type DiagCommandDispatchContext = Parameters<typeof runSendDiagCommand>[0];

interface DiagCommandContextInput {
  outputLanguage: DiagCommandDispatchContext["outputLanguage"];
  botNoticePrefix: string;
  processStartedAtIso: string;
  defaultBackendProfile: BackendModelRouteProfile;
  autoDevLoopMaxRuns: number;
  autoDevLoopMaxMinutes: number;
  autoDevAutoCommit: boolean;
  autoDevAutoReleaseEnabled: boolean;
  autoDevAutoReleasePush: boolean;
  autoDevMaxConsecutiveFailures: number;
  runningExecutionsSize: number;
  cliCompat: {
    fetchMedia: boolean;
    imageMaxCount: number;
    imageMaxBytes: number;
    imageAllowedMimeTypes: string[];
    audioTranscribeMaxBytes: number;
    audioTranscribeModel: string;
  };
  isAudioTranscriberEnabled: DiagCommandDispatchContext["isAudioTranscriberEnabled"];
  getPackageUpdateStatus: DiagCommandDispatchContext["getPackageUpdateStatus"];
  formatBackendToolLabel: DiagCommandDispatchContext["formatBackendToolLabel"];
  mediaMetrics: DiagCommandDispatchContext["mediaMetrics"];
  listWorkflowDiagRuns: DiagCommandDispatchContext["listWorkflowDiagRuns"];
  listWorkflowDiagEvents: DiagCommandDispatchContext["listWorkflowDiagEvents"];
  autoDevSnapshots: Map<string, AutoDevRunSnapshot>;
  listAutoDevGitCommitRecords: DiagCommandDispatchContext["listAutoDevGitCommitRecords"];
  listRecentAutoDevGitCommitEventSummaries: DiagCommandDispatchContext["listRecentAutoDevGitCommitEventSummaries"];
  resolveSessionBackendStatusProfile: DiagCommandDispatchContext["resolveSessionBackendStatusProfile"];
  sessionBackendOverrides: Map<string, SessionBackendOverride>;
  sessionLastBackendDecisions: Map<string, SessionBackendDecision>;
  getBackendModelRouterStats: DiagCommandDispatchContext["getBackendModelRouterStats"];
  listBackendRouteDiagRecords: DiagCommandDispatchContext["listBackendRouteDiagRecords"];
  getTaskQueueStateStore: DiagCommandDispatchContext["getTaskQueueStateStore"];
  listTaskQueueFailureArchive: DiagCommandDispatchContext["listTaskQueueFailureArchive"];
  getRecentUpgradeRuns: DiagCommandDispatchContext["getRecentUpgradeRuns"];
  getUpgradeExecutionLockSnapshot: DiagCommandDispatchContext["getUpgradeExecutionLockSnapshot"];
  getUpgradeRunStats: DiagCommandDispatchContext["getUpgradeRunStats"];
  sendNotice: DiagCommandDispatchContext["sendNotice"];
}

interface DiagCommandRuntimeContextInput {
  outputLanguage: DiagCommandDispatchContext["outputLanguage"];
  botNoticePrefix: string;
  processStartedAtIso: string;
  defaultBackendProfile: BackendModelRouteProfile;
  autoDevConfig: {
    loopMaxRuns: number;
    loopMaxMinutes: number;
    autoCommit: boolean;
    autoReleaseEnabled: boolean;
    autoReleasePush: boolean;
    maxConsecutiveFailures: number;
  };
  runningExecutions: { size: number };
  cliCompat: DiagCommandContextInput["cliCompat"];
  audioTranscriber: { isEnabled: DiagCommandContextInput["isAudioTranscriberEnabled"] };
  packageUpdateChecker: { getStatus: DiagCommandContextInput["getPackageUpdateStatus"] };
  formatBackendToolLabel: DiagCommandContextInput["formatBackendToolLabel"];
  mediaMetrics: DiagCommandContextInput["mediaMetrics"];
  listWorkflowDiagRuns: DiagCommandContextInput["listWorkflowDiagRuns"];
  listWorkflowDiagEvents: DiagCommandContextInput["listWorkflowDiagEvents"];
  autoDevSnapshots: Map<string, AutoDevRunSnapshot>;
  listAutoDevGitCommitRecords: DiagCommandContextInput["listAutoDevGitCommitRecords"];
  listRecentAutoDevGitCommitEventSummaries: DiagCommandContextInput["listRecentAutoDevGitCommitEventSummaries"];
  resolveSessionBackendStatusProfile: DiagCommandContextInput["resolveSessionBackendStatusProfile"];
  sessionBackendOverrides: Map<string, SessionBackendOverride>;
  sessionLastBackendDecisions: Map<string, SessionBackendDecision>;
  backendModelRouter: { getStats: DiagCommandContextInput["getBackendModelRouterStats"] };
  listBackendRouteDiagRecords: DiagCommandContextInput["listBackendRouteDiagRecords"];
  getTaskQueueStateStore: DiagCommandContextInput["getTaskQueueStateStore"];
  listTaskQueueFailureArchive: DiagCommandContextInput["listTaskQueueFailureArchive"];
  getRecentUpgradeRuns: DiagCommandContextInput["getRecentUpgradeRuns"];
  getUpgradeExecutionLockSnapshot: DiagCommandContextInput["getUpgradeExecutionLockSnapshot"];
  getUpgradeRunStats: DiagCommandContextInput["getUpgradeRunStats"];
  sendNotice: DiagCommandContextInput["sendNotice"];
}

export function buildDiagCommandDispatchContext(input: DiagCommandContextInput): DiagCommandDispatchContext {
  return {
    outputLanguage: input.outputLanguage,
    botNoticePrefix: input.botNoticePrefix,
    processStartedAtIso: input.processStartedAtIso,
    defaultBackendProfile: input.defaultBackendProfile,
    autoDevLoopMaxRuns: input.autoDevLoopMaxRuns,
    autoDevLoopMaxMinutes: input.autoDevLoopMaxMinutes,
    autoDevAutoCommit: input.autoDevAutoCommit,
    autoDevAutoReleaseEnabled: input.autoDevAutoReleaseEnabled,
    autoDevAutoReleasePush: input.autoDevAutoReleasePush,
    autoDevMaxConsecutiveFailures: input.autoDevMaxConsecutiveFailures,
    runningExecutionsSize: input.runningExecutionsSize,
    cliCompat: input.cliCompat,
    isAudioTranscriberEnabled: () => input.isAudioTranscriberEnabled(),
    getPackageUpdateStatus: (query) => input.getPackageUpdateStatus(query),
    formatBackendToolLabel: (profile) => input.formatBackendToolLabel(profile),
    mediaMetrics: input.mediaMetrics,
    listWorkflowDiagRuns: (kind, limit) => input.listWorkflowDiagRuns(kind, limit),
    listWorkflowDiagEvents: (runId, limit) => input.listWorkflowDiagEvents(runId, limit),
    getAutoDevSnapshot: (sessionKey: string) => input.autoDevSnapshots.get(sessionKey) ?? createIdleAutoDevSnapshot(),
    listAutoDevGitCommitRecords: (limit) => input.listAutoDevGitCommitRecords(limit),
    listRecentAutoDevGitCommitEventSummaries: (limit) => input.listRecentAutoDevGitCommitEventSummaries(limit),
    resolveSessionBackendStatusProfile: (sessionKey) => input.resolveSessionBackendStatusProfile(sessionKey),
    getSessionBackendOverride: (sessionKey) => input.sessionBackendOverrides.get(sessionKey),
    getSessionBackendDecision: (sessionKey) => input.sessionLastBackendDecisions.get(sessionKey),
    getBackendModelRouterStats: () => input.getBackendModelRouterStats(),
    listBackendRouteDiagRecords: (limit, sessionKey) => input.listBackendRouteDiagRecords(limit, sessionKey),
    getTaskQueueStateStore: () => input.getTaskQueueStateStore(),
    listTaskQueueFailureArchive: (limit) => input.listTaskQueueFailureArchive(limit),
    getRecentUpgradeRuns: (limit) => input.getRecentUpgradeRuns(limit),
    getUpgradeExecutionLockSnapshot: () => input.getUpgradeExecutionLockSnapshot(),
    getUpgradeRunStats: () => input.getUpgradeRunStats(),
    sendNotice: (conversationId, text) => input.sendNotice(conversationId, text),
  };
}

export function buildDiagCommandDispatchContextFromRuntime(
  input: DiagCommandRuntimeContextInput,
): DiagCommandDispatchContext {
  return buildDiagCommandDispatchContext({
    outputLanguage: input.outputLanguage,
    botNoticePrefix: input.botNoticePrefix,
    processStartedAtIso: input.processStartedAtIso,
    defaultBackendProfile: input.defaultBackendProfile,
    autoDevLoopMaxRuns: input.autoDevConfig.loopMaxRuns,
    autoDevLoopMaxMinutes: input.autoDevConfig.loopMaxMinutes,
    autoDevAutoCommit: input.autoDevConfig.autoCommit,
    autoDevAutoReleaseEnabled: input.autoDevConfig.autoReleaseEnabled,
    autoDevAutoReleasePush: input.autoDevConfig.autoReleasePush,
    autoDevMaxConsecutiveFailures: input.autoDevConfig.maxConsecutiveFailures,
    runningExecutionsSize: input.runningExecutions.size,
    cliCompat: input.cliCompat,
    isAudioTranscriberEnabled: () => input.audioTranscriber.isEnabled(),
    getPackageUpdateStatus: (query) => input.packageUpdateChecker.getStatus(query),
    formatBackendToolLabel: input.formatBackendToolLabel,
    mediaMetrics: input.mediaMetrics,
    listWorkflowDiagRuns: input.listWorkflowDiagRuns,
    listWorkflowDiagEvents: input.listWorkflowDiagEvents,
    autoDevSnapshots: input.autoDevSnapshots,
    listAutoDevGitCommitRecords: input.listAutoDevGitCommitRecords,
    listRecentAutoDevGitCommitEventSummaries: input.listRecentAutoDevGitCommitEventSummaries,
    resolveSessionBackendStatusProfile: input.resolveSessionBackendStatusProfile,
    sessionBackendOverrides: input.sessionBackendOverrides,
    sessionLastBackendDecisions: input.sessionLastBackendDecisions,
    getBackendModelRouterStats: () => input.backendModelRouter.getStats(),
    listBackendRouteDiagRecords: input.listBackendRouteDiagRecords,
    getTaskQueueStateStore: input.getTaskQueueStateStore,
    listTaskQueueFailureArchive: input.listTaskQueueFailureArchive,
    getRecentUpgradeRuns: input.getRecentUpgradeRuns,
    getUpgradeExecutionLockSnapshot: input.getUpgradeExecutionLockSnapshot,
    getUpgradeRunStats: input.getUpgradeRunStats,
    sendNotice: input.sendNotice,
  });
}
