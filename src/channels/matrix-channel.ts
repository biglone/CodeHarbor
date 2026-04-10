import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ClientEvent,
  createClient,
  MatrixClient,
  type MatrixEvent,
  RoomEvent,
  type RoomMember,
  RoomMemberEvent,
  type Room,
  SyncState,
} from "matrix-js-sdk";

import { AppConfig } from "../config";
import { Logger } from "../logger";
import {
  classifyRetryDecision,
  createRetryPolicy,
  DEFAULT_RETRYABLE_HTTP_STATUSES,
  sleep,
  type RetryPolicy,
} from "../reliability/retry-policy";
import { DEFAULT_DOCUMENT_MAX_BYTES, isSupportedDocumentAttachment } from "../document-extractor";
import { InboundAttachment, InboundMessage } from "../types";
import { splitText } from "../utils/message";
import {
  Channel,
  type InboundHandler,
  type OutboundMultimodalAudioSummary,
  type OutboundMultimodalSummary,
  type SendFileOptions,
  type SendMessageOptions,
} from "./channel";

export type { InboundHandler } from "./channel";
const LOCAL_TXN_PREFIX = "codeharbor-";
const MATRIX_HTTP_TIMEOUT_MS = 15_000;
const MATRIX_HTTP_MAX_RETRIES = 2;
const MATRIX_HTTP_RETRY_POLICY = createRetryPolicy({
  maxAttempts: MATRIX_HTTP_MAX_RETRIES + 1,
  initialDelayMs: 250,
  maxDelayMs: 2_000,
  multiplier: 2,
  jitterRatio: 0.2,
});
const MATRIX_RETRYABLE_HTTP_STATUSES = new Set([...DEFAULT_RETRYABLE_HTTP_STATUSES, 530]);
const ACCEPTED_MSG_TYPES = new Set(["m.text", "m.image", "m.file", "m.audio", "m.video"]);

export class MatrixChannel implements Channel {
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly chunkSize: number;
  private readonly splitReplies: boolean;
  private readonly preserveWhitespace: boolean;
  private readonly fetchMedia: boolean;
  private readonly transcribeAudio: boolean;
  private readonly client: MatrixClient;
  private readonly ignoredBotSenderIds: ReadonlySet<string>;
  private handler: InboundHandler | null = null;
  private started = false;

  constructor(config: AppConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.chunkSize = config.replyChunkSize;
    this.splitReplies = !config.cliCompat.disableReplyChunkSplit;
    this.preserveWhitespace = config.cliCompat.preserveWhitespace;
    this.fetchMedia = config.cliCompat.fetchMedia;
    this.transcribeAudio = config.cliCompat.transcribeAudio;
    this.client = createClient({
      baseUrl: config.matrixHomeserver,
      accessToken: config.matrixAccessToken,
      userId: config.matrixUserId,
    });
    this.ignoredBotSenderIds = parseMatrixBotSenderIds(process.env.MATRIX_BOT_USER_IDS, config.matrixUserId);
  }

  async start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
    this.client.on(RoomEvent.Timeline, this.onTimeline);
    this.client.on(RoomMemberEvent.Membership, this.onMembership);
    const readyPromise = this.waitUntilReady();
    this.client.startClient({ initialSyncLimit: 10 });
    await readyPromise;
    await this.joinPendingInvites();
    this.started = true;
    this.logger.info("Matrix channel ready.");
  }

  async sendMessage(conversationId: string, text: string, options?: SendMessageOptions): Promise<void> {
    if (!this.started) {
      throw new Error("Matrix channel not started.");
    }

    const multimodalSummary = normalizeMultimodalSummary(options?.multimodalSummary ?? null);
    const requestId = normalizeRequestId(options?.requestId ?? null);
    const chunks = this.splitReplies ? splitText(text, this.chunkSize) : [text];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? "";
      await this.sendRichText(
        conversationId,
        chunk,
        "m.text",
        index === 0 ? multimodalSummary : null,
        index === chunks.length - 1 ? requestId : null,
      );
    }
  }

  async sendFile(conversationId: string, filePath: string, options?: SendFileOptions): Promise<void> {
    if (!this.started) {
      throw new Error("Matrix channel not started.");
    }

    const normalizedPath = filePath.trim();
    if (!normalizedPath) {
      throw new Error("File path cannot be empty.");
    }
    const stats = await fs.stat(normalizedPath);
    if (!stats.isFile()) {
      throw new Error(`File does not exist: ${normalizedPath}`);
    }

    const fileName = normalizeOutboundFileName(options?.fileName, normalizedPath);
    const mimeType = normalizeMimeType(options?.mimeType ?? inferMimeTypeFromFileName(fileName));
    const payload = await fs.readFile(normalizedPath);
    const contentUri = await this.uploadFilePayload(payload, fileName, mimeType);
    const msgtype = resolveOutboundFileMsgtype(mimeType);
    const content: Record<string, unknown> = {
      msgtype,
      body: fileName,
      filename: fileName,
      url: contentUri,
      info: {
        size: stats.size,
        ...(mimeType ? { mimetype: mimeType } : {}),
      },
    };
    await this.sendRawEvent(conversationId, content);
  }

  async sendNotice(conversationId: string, text: string): Promise<void> {
    if (!this.started) {
      throw new Error("Matrix channel not started.");
    }

    const chunks = this.splitReplies ? splitText(text, this.chunkSize) : [text];
    for (const chunk of chunks) {
      await this.sendRichText(conversationId, chunk, "m.notice");
    }
  }

  async upsertProgressNotice(conversationId: string, text: string, replaceEventId: string | null): Promise<string> {
    if (!this.started) {
      throw new Error("Matrix channel not started.");
    }

    const normalized = (this.splitReplies ? splitText(text, this.chunkSize)[0] : text) ?? "";
    if (!normalized.trim()) {
      throw new Error("Progress notice cannot be empty.");
    }

    if (!replaceEventId) {
      const response = await this.sendRawEvent(
        conversationId,
        buildMatrixRichMessageContent(normalized, "m.notice", null, this.config.matrixNoticeBadgeEnabled),
      );
      return response.event_id;
    }

    const replacementRichContent = buildMatrixRichMessageContent(
      normalized,
      "m.notice",
      null,
      this.config.matrixNoticeBadgeEnabled,
    );

    const content = {
      msgtype: "m.notice",
      body: `* ${normalized}`,
      "m.new_content": replacementRichContent,
      "m.relates_to": {
        rel_type: "m.replace",
        event_id: replaceEventId,
      },
    } as const;

    const response = await this.sendRawEvent(conversationId, content as Record<string, unknown>);
    return response.event_id;
  }

  async setTyping(conversationId: string, isTyping: boolean, timeoutMs: number): Promise<void> {
    if (!this.started) {
      throw new Error("Matrix channel not started.");
    }
    const safeTimeout = Math.max(0, timeoutMs);
    await this.client.sendTyping(conversationId, isTyping, safeTimeout);
  }

  async stop(): Promise<void> {
    this.client.removeListener(RoomEvent.Timeline, this.onTimeline);
    this.client.removeListener(RoomMemberEvent.Membership, this.onMembership);
    this.client.stopClient();
    this.started = false;
  }

  private readonly onMembership = (_event: MatrixEvent, member: RoomMember): void => {
    if (!member || member.membership !== "invite") {
      return;
    }
    if (member.userId !== this.config.matrixUserId) {
      return;
    }
    if (!member.roomId) {
      return;
    }

    void this.joinInvitedRoom(member.roomId);
  };

  private readonly onTimeline = (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline?: boolean,
  ): void => {
    if (!this.handler || !room || toStartOfTimeline) {
      return;
    }
    if (event.getType() !== "m.room.message") {
      return;
    }
    const senderId = event.getSender();
    if (!senderId) {
      return;
    }
    if (this.ignoredBotSenderIds.has(senderId)) {
      this.logger.debug("Ignored inbound message from configured bot sender", {
        senderId,
        roomId: room.roomId,
      });
      return;
    }
    if (senderId === this.config.matrixUserId && isLikelyLocalEcho(event)) {
      return;
    }

    const content = event.getContent();
    if (!content || typeof content !== "object") {
      return;
    }

    const msgtype = typeof content.msgtype === "string" ? content.msgtype : "";
    if (!ACCEPTED_MSG_TYPES.has(msgtype)) {
      return;
    }

    const eventId = event.getId();
    if (!eventId || typeof eventId !== "string") {
      return;
    }

    const body = typeof content.body === "string" ? content.body : "";
    const text = this.preserveWhitespace ? body : body.trim();
    const attachments = extractAttachments(content);
    if (!text.trim() && attachments.length === 0) {
      return;
    }

    const isDirectMessage = isDirectRoom(room);
    const mentionsBot = checkMentionsBot(content, text, this.config.matrixUserId);
    const repliesToBot = checkRepliesToBot(content, room, this.config.matrixUserId);

    void this.dispatchInbound({
      senderId,
      roomId: room.roomId,
      eventId,
      text,
      attachments,
      isDirectMessage,
      mentionsBot,
      repliesToBot,
    });
  };

  private async dispatchInbound(params: {
    senderId: string;
    roomId: string;
    eventId: string;
    text: string;
    attachments: InboundAttachment[];
    isDirectMessage: boolean;
    mentionsBot: boolean;
    repliesToBot: boolean;
  }): Promise<void> {
    if (!this.handler) {
      return;
    }
    const hydratedAttachments = await this.hydrateAttachments(params.attachments, params.eventId);
    const inbound: InboundMessage = {
      requestId: buildRequestId(params.eventId),
      channel: "matrix",
      conversationId: params.roomId,
      senderId: params.senderId,
      eventId: params.eventId,
      text: params.text,
      attachments: hydratedAttachments,
      isDirectMessage: params.isDirectMessage,
      mentionsBot: params.mentionsBot,
      repliesToBot: params.repliesToBot,
    };

    try {
      await this.handler(inbound);
    } catch (error) {
      this.logger.error("Unhandled inbound processing error", error);
    }
  }

  private async waitUntilReady(timeoutMs = 60_000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const currentState = this.client.getSyncState();
      if (currentState === "PREPARED" || currentState === "SYNCING") {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Matrix sync timeout."));
      }, timeoutMs);

      const onSync = (state: SyncState): void => {
        if (state === "PREPARED" || state === "SYNCING") {
          cleanup();
          resolve();
        } else if (state === "ERROR") {
          cleanup();
          reject(new Error("Matrix sync error."));
        }
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        this.client.removeListener(ClientEvent.Sync, onSync);
      };

      this.client.on(ClientEvent.Sync, onSync);
    });
  }

  private async joinInvitedRoom(roomId: string): Promise<void> {
    try {
      this.logger.info("Received room invite, joining", { roomId });
      await this.client.joinRoom(roomId);
      this.logger.info("Joined room", { roomId });
    } catch (error) {
      this.logger.error("Failed to join invited room", { roomId, error });
    }
  }

  private async joinPendingInvites(): Promise<void> {
    const rooms = this.client.getRooms();
    for (const room of rooms) {
      if (room.getMyMembership() !== "invite") {
        continue;
      }
      await this.joinInvitedRoom(room.roomId);
    }
  }

  private async sendRichText(
    conversationId: string,
    text: string,
    msgtype: "m.text" | "m.notice",
    multimodalSummary: OutboundMultimodalSummary | null = null,
    requestId: string | null = null,
  ): Promise<void> {
    const payload = buildMatrixRichMessageContent(
      text,
      msgtype,
      multimodalSummary,
      this.config.matrixNoticeBadgeEnabled,
      requestId,
    );
    await this.sendRawEvent(conversationId, payload);
  }

  private async sendRawEvent(
    conversationId: string,
    content: Record<string, unknown>,
  ): Promise<{ event_id: string }> {
    const txnId = `${LOCAL_TXN_PREFIX}${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const url = `${this.config.matrixHomeserver}/_matrix/client/v3/rooms/${encodeURIComponent(conversationId)}/send/m.room.message/${encodeURIComponent(txnId)}`;
    const response = await fetchWithRetry(
      url,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.config.matrixAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(content),
      },
      {
        timeoutMs: MATRIX_HTTP_TIMEOUT_MS,
        policy: MATRIX_HTTP_RETRY_POLICY,
        retryableStatuses: MATRIX_RETRYABLE_HTTP_STATUSES,
      },
    );

    if (!response.ok) {
      const responseSnippet = await readResponseSnippet(response);
      throw new Error(
        `Matrix send failed (${response.status} ${response.statusText})${responseSnippet ? `: ${responseSnippet}` : ""}`,
      );
    }

    const payload = (await response.json()) as { event_id?: unknown };
    if (!payload.event_id || typeof payload.event_id !== "string") {
      throw new Error("Matrix send failed (missing event_id)");
    }
    return { event_id: payload.event_id };
  }

  private async uploadFilePayload(payload: Buffer, fileName: string, mimeType: string | null): Promise<string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.matrixAccessToken}`,
      "Content-Type": mimeType ?? "application/octet-stream",
    };
    const encodedName = encodeURIComponent(fileName);
    const mediaUrls = [
      `${this.config.matrixHomeserver}/_matrix/media/v3/upload?filename=${encodedName}`,
      `${this.config.matrixHomeserver}/_matrix/media/r0/upload?filename=${encodedName}`,
    ];
    const failedStatuses: number[] = [];
    for (const url of mediaUrls) {
      const response = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers,
          body: new Uint8Array(payload),
        },
        {
          timeoutMs: MATRIX_HTTP_TIMEOUT_MS,
          policy: MATRIX_HTTP_RETRY_POLICY,
          retryableStatuses: MATRIX_RETRYABLE_HTTP_STATUSES,
        },
      );
      if (!response.ok) {
        failedStatuses.push(response.status);
        continue;
      }
      const body = (await response.json()) as { content_uri?: unknown };
      if (typeof body.content_uri === "string" && body.content_uri.startsWith("mxc://")) {
        return body.content_uri;
      }
      throw new Error("Matrix upload failed (missing content_uri).");
    }
    const suffix = failedStatuses.length > 0 ? ` (statuses: ${failedStatuses.join(",")})` : "";
    throw new Error(`Matrix upload failed for ${fileName}${suffix}`);
  }

  private async hydrateAttachments(
    attachments: InboundAttachment[],
    eventId: string,
  ): Promise<InboundAttachment[]> {
    if (!this.fetchMedia || attachments.length === 0) {
      return attachments;
    }

    const hydrated = await Promise.all(
      attachments.map(async (attachment, index) => {
        if (!shouldHydrateAttachment(attachment, this.transcribeAudio) || !attachment.mxcUrl) {
          return attachment;
        }
        try {
          const localPath = await this.downloadMxcAttachment(
            attachment.mxcUrl,
            attachment.name,
            attachment.mimeType,
            eventId,
            index,
          );
          return {
            ...attachment,
            localPath,
          };
        } catch (error) {
          this.logger.warn("Failed to hydrate attachment", {
            eventId,
            mxcUrl: attachment.mxcUrl,
            error,
          });
          return attachment;
        }
      }),
    );

    return hydrated;
  }

  private async downloadMxcAttachment(
    mxcUrl: string,
    fileName: string,
    mimeType: string | null,
    eventId: string,
    index: number,
  ): Promise<string> {
    const parsed = parseMxcUrl(mxcUrl);
    if (!parsed) {
      throw new Error(`Unsupported MXC URL: ${mxcUrl}`);
    }

    const mediaUrls = [
      `${this.config.matrixHomeserver}/_matrix/media/v3/download/${encodeURIComponent(parsed.serverName)}/${encodeURIComponent(parsed.mediaId)}`,
      `${this.config.matrixHomeserver}/_matrix/media/r0/download/${encodeURIComponent(parsed.serverName)}/${encodeURIComponent(parsed.mediaId)}`,
    ];
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.matrixAccessToken}`,
    };

    let response: Response | null = null;
    const failedStatuses: number[] = [];
    for (const url of mediaUrls) {
      const candidate = await fetchWithRetry(
        url,
        { headers },
        {
          timeoutMs: MATRIX_HTTP_TIMEOUT_MS,
          policy: MATRIX_HTTP_RETRY_POLICY,
          retryableStatuses: MATRIX_RETRYABLE_HTTP_STATUSES,
        },
      );
      if (candidate.ok) {
        response = candidate;
        break;
      }
      failedStatuses.push(candidate.status);
    }
    if (!response) {
      const suffix = failedStatuses.length > 0 ? ` (statuses: ${failedStatuses.join(",")})` : "";
      throw new Error(`Failed to download media for ${mxcUrl}${suffix}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const extension = resolveFileExtension(fileName, mimeType);
    const directory = path.join(os.tmpdir(), "codeharbor-media");
    await fs.mkdir(directory, { recursive: true });
    const safeEventId = sanitizeFilename(eventId);
    const targetPath = path.join(directory, `${safeEventId}-${index}${extension}`);
    await fs.writeFile(targetPath, bytes);
    return targetPath;
  }
}

interface FetchRetryOptions {
  timeoutMs: number;
  policy: RetryPolicy;
  retryableStatuses: ReadonlySet<number>;
}

async function fetchWithRetry(url: string, init: RequestInit, options: FetchRetryOptions): Promise<Response> {
  let attempt = 1;
  let lastError: unknown = null;

  while (attempt <= options.policy.maxAttempts) {
    try {
      const response = await fetchWithTimeout(url, init, options.timeoutMs);
      const retryDecision = classifyRetryDecision({
        policy: options.policy,
        attempt,
        error: {
          status: response.status,
          retryAfter: readRetryAfterHeader(response),
          message: `HTTP ${response.status} ${response.statusText}`,
        },
        options: {
          retryableHttpStatuses: options.retryableStatuses,
        },
      });
      if (!retryDecision.shouldRetry) {
        return response;
      }
      await sleep(retryDecision.retryDelayMs ?? 0);
    } catch (error) {
      lastError = error;
      const retryDecision = classifyRetryDecision({
        policy: options.policy,
        attempt,
        error,
      });
      if (!retryDecision.shouldRetry) {
        throw error;
      }
      await sleep(retryDecision.retryDelayMs ?? 0);
    }
    attempt += 1;
  }

  throw new Error(`HTTP request failed for ${url}: ${formatError(lastError)}`);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function readRetryAfterHeader(response: Response): string | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const headers = response.headers as { get?: ((name: string) => string | null) | undefined } | undefined;
  if (!headers || typeof headers.get !== "function") {
    return null;
  }
  return headers.get("retry-after");
}

async function readResponseSnippet(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return "";
    }
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
  } catch {
    return "";
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function buildRequestId(eventId: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${eventId}:${suffix}`;
}

function parseMatrixBotSenderIds(raw: string | undefined, selfUserId: string): ReadonlySet<string> {
  const normalizedSelf = selfUserId.trim();
  const values = (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const output = new Set<string>();
  for (const value of values) {
    if (value === normalizedSelf) {
      continue;
    }
    if (!/^@[^:\s]+:.+/.test(value)) {
      continue;
    }
    output.add(value);
  }
  return output;
}

function isLikelyLocalEcho(event: MatrixEvent): boolean {
  const unsigned = event.getUnsigned();
  if (!unsigned || typeof unsigned !== "object") {
    return false;
  }
  const transactionId = (unsigned as { transaction_id?: unknown }).transaction_id;
  if (typeof transactionId !== "string" || !transactionId) {
    return false;
  }
  return transactionId.startsWith(LOCAL_TXN_PREFIX);
}

function isDirectRoom(room: Room): boolean {
  return room.getJoinedMemberCount() <= 2;
}

function checkMentionsBot(content: Record<string, unknown>, body: string, botUserId: string): boolean {
  const mentions = content["m.mentions"];
  if (mentions && typeof mentions === "object") {
    const userIds = (mentions as { user_ids?: unknown }).user_ids;
    if (Array.isArray(userIds) && userIds.some((userId) => userId === botUserId)) {
      return true;
    }
  }
  if (body.includes(botUserId)) {
    return true;
  }
  const localpart = parseMatrixUserLocalpart(botUserId);
  if (!localpart) {
    return false;
  }
  const escapedMention = escapeRegex(`@${localpart}`);
  // Accept plain-text mentions like "@dev-main ...", even when clients do not include m.mentions.user_ids.
  const mentionPattern = new RegExp(`(?:^|[\\s([{<])${escapedMention}(?=$|[\\s,.:;!?\\])}>])`, "i");
  return mentionPattern.test(body);
}

function checkRepliesToBot(content: Record<string, unknown>, room: Room, botUserId: string): boolean {
  const relatesTo = content["m.relates_to"];
  if (!relatesTo || typeof relatesTo !== "object") {
    return false;
  }

  const inReplyTo = (relatesTo as { "m.in_reply_to"?: unknown })["m.in_reply_to"];
  if (!inReplyTo || typeof inReplyTo !== "object") {
    return false;
  }

  const eventId = (inReplyTo as { event_id?: unknown }).event_id;
  if (typeof eventId !== "string" || !eventId) {
    return false;
  }

  const repliedEvent = room.findEventById(eventId);
  return repliedEvent?.getSender() === botUserId;
}

function extractAttachments(content: Record<string, unknown>): InboundAttachment[] {
  const msgtype = typeof content.msgtype === "string" ? content.msgtype : "";
  const mapping: Record<string, InboundAttachment["kind"]> = {
    "m.image": "image",
    "m.file": "file",
    "m.audio": "audio",
    "m.video": "video",
  };
  const kind = mapping[msgtype];
  if (!kind) {
    return [];
  }

  const body = typeof content.body === "string" && content.body.trim() ? content.body.trim() : "attachment";
  const info = content.info && typeof content.info === "object" ? (content.info as Record<string, unknown>) : {};
  const mimeType = typeof info.mimetype === "string" ? info.mimetype : null;
  const sizeBytes = typeof info.size === "number" ? info.size : null;

  const directUrl = typeof content.url === "string" ? content.url : null;
  const encryptedFile = content.file && typeof content.file === "object" ? (content.file as Record<string, unknown>) : {};
  const encryptedUrl = typeof encryptedFile.url === "string" ? encryptedFile.url : null;

  return [
    {
      kind,
      name: body,
      mxcUrl: directUrl ?? encryptedUrl,
      mimeType,
      sizeBytes,
      localPath: null,
    },
  ];
}

function parseMxcUrl(mxcUrl: string): { serverName: string; mediaId: string } | null {
  if (!mxcUrl.startsWith("mxc://")) {
    return null;
  }
  const stripped = mxcUrl.slice("mxc://".length);
  const slashIndex = stripped.indexOf("/");
  if (slashIndex <= 0 || slashIndex === stripped.length - 1) {
    return null;
  }
  const serverName = stripped.slice(0, slashIndex);
  const mediaId = stripped.slice(slashIndex + 1);
  return { serverName, mediaId };
}

function shouldHydrateAttachment(attachment: InboundAttachment, transcribeAudio: boolean): boolean {
  if (attachment.kind === "image") {
    return true;
  }
  if (attachment.kind === "audio") {
    return transcribeAudio;
  }
  if (attachment.kind === "file") {
    if (!isSupportedDocumentAttachment({ name: attachment.name, mimeType: attachment.mimeType })) {
      return false;
    }
    if (attachment.sizeBytes !== null && attachment.sizeBytes > DEFAULT_DOCUMENT_MAX_BYTES) {
      return false;
    }
    return true;
  }
  return false;
}

function parseMatrixUserLocalpart(userId: string): string | null {
  if (!userId.startsWith("@")) {
    return null;
  }
  const colonIndex = userId.indexOf(":");
  if (colonIndex <= 1) {
    return null;
  }
  return userId.slice(1, colonIndex);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function resolveFileExtension(fileName: string, mimeType: string | null): string {
  const ext = path.extname(fileName).trim();
  if (ext) {
    return ext;
  }
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (normalizedMimeType === "image/png") {
    return ".png";
  }
  if (normalizedMimeType === "image/jpeg") {
    return ".jpg";
  }
  if (normalizedMimeType === "image/webp") {
    return ".webp";
  }
  if (normalizedMimeType === "audio/mpeg") {
    return ".mp3";
  }
  if (normalizedMimeType === "audio/mp4" || normalizedMimeType === "audio/x-m4a") {
    return ".m4a";
  }
  if (normalizedMimeType === "audio/wav" || normalizedMimeType === "audio/x-wav") {
    return ".wav";
  }
  if (normalizedMimeType === "audio/ogg") {
    return ".ogg";
  }
  if (normalizedMimeType === "audio/flac") {
    return ".flac";
  }
  if (normalizedMimeType === "application/pdf") {
    return ".pdf";
  }
  if (normalizedMimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return ".docx";
  }
  if (normalizedMimeType === "text/plain") {
    return ".txt";
  }
  return ".bin";
}

function normalizeOutboundFileName(inputName: string | undefined, fallbackPath: string): string {
  const candidate = (inputName ?? "").trim() || path.basename(fallbackPath).trim();
  if (!candidate) {
    return "attachment.bin";
  }
  return candidate.replace(/[\\/\0]/g, "_");
}

function resolveOutboundFileMsgtype(mimeType: string | null): "m.file" | "m.image" | "m.audio" | "m.video" {
  if (!mimeType) {
    return "m.file";
  }
  if (mimeType.startsWith("image/")) {
    return "m.image";
  }
  if (mimeType.startsWith("audio/")) {
    return "m.audio";
  }
  if (mimeType.startsWith("video/")) {
    return "m.video";
  }
  return "m.file";
}

function inferMimeTypeFromFileName(fileName: string): string | null {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    case ".flac":
      return "audio/flac";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    case ".pdf":
      return "application/pdf";
    case ".json":
      return "application/json";
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".csv":
      return "text/csv";
    case ".zip":
      return "application/zip";
    default:
      return null;
  }
}

function normalizeMimeType(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || null;
}

function buildMatrixRichMessageContent(
  body: string,
  msgtype: "m.text" | "m.notice",
  multimodalSummary: OutboundMultimodalSummary | null = null,
  noticeBadgeEnabled = true,
  requestId: string | null = null,
): Record<string, unknown> {
  const plainBody = buildMatrixPlainBody(body, multimodalSummary, requestId);
  return {
    msgtype,
    body: plainBody,
    format: "org.matrix.custom.html",
    formatted_body: renderMatrixHtml(body, msgtype, multimodalSummary, noticeBadgeEnabled, requestId),
  };
}

function renderMatrixHtml(
  body: string,
  msgtype: "m.text" | "m.notice",
  multimodalSummary: OutboundMultimodalSummary | null = null,
  noticeBadgeEnabled = true,
  requestId: string | null = null,
): string {
  const normalized = body.replace(/\r\n/g, "\n");
  const sections: string[] = [];
  const normalizedSummary = normalizeMultimodalSummary(multimodalSummary);
  if (normalizedSummary) {
    sections.push(renderMultimodalSummaryHtml(normalizedSummary));
    sections.push(`<p><font color="#3558d1"><b>结论</b></font></p>`);
  }

  const renderedBodySections = renderMarkdownAndCodeSections(normalized);
  if (renderedBodySections.length === 0) {
    sections.push(normalizedSummary ? "<p>（未返回文本结论）</p>" : "<p>(空消息)</p>");
  } else {
    sections.push(...renderedBodySections);
  }
  if (requestId) {
    sections.push(renderRequestIdHtml(requestId));
  }

  const badge = noticeBadgeEnabled
    ? msgtype === "m.notice"
      ? `<p><font color="#8a5a00"><b>CodeHarbor 提示</b></font></p>`
      : `<p><font color="#1f7a5a"><b>CodeHarbor AI 回复</b></font></p>`
    : "";

  return `<div>${badge}${sections.join("")}</div>`;
}

function renderMarkdownAndCodeSections(normalized: string): string[] {
  const sections: string[] = [];
  const codeFencePattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = codeFencePattern.exec(normalized)) !== null) {
    const before = normalized.slice(cursor, match.index);
    const renderedBefore = renderMarkdownSection(before);
    if (renderedBefore) {
      sections.push(renderedBefore);
    }

    const language = escapeHtml(match[1]?.trim() || "text");
    const code = escapeHtml(match[2].replace(/\n$/, ""));
    const label = language && language !== "text" ? `代码 (${language})` : "代码";
    sections.push(`<p><font color="#3558d1"><b>${label}</b></font></p><pre><code>${code}</code></pre>`);

    cursor = match.index + match[0].length;
  }

  const tail = normalized.slice(cursor);
  const renderedTail = renderMarkdownSection(tail);
  if (renderedTail) {
    sections.push(renderedTail);
  }
  return sections;
}

function buildMatrixPlainBody(
  body: string,
  multimodalSummary: OutboundMultimodalSummary | null,
  requestId: string | null,
): string {
  const normalizedSummary = normalizeMultimodalSummary(multimodalSummary);
  const summaryText = normalizedSummary ? buildMultimodalSummaryText(normalizedSummary) : "";
  const requestIdText = requestId ? buildRequestIdText(requestId) : "";
  const segments = [summaryText, body.trim() ? body : "", requestIdText].filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return body;
  }
  return segments.join("\n\n");
}

function buildMultimodalSummaryText(summary: OutboundMultimodalSummary): string {
  const lines: string[] = ["[CodeHarbor 多模态摘要]"];
  if (summary.images) {
    const skipped = Math.max(0, summary.images.total - summary.images.included);
    const imageLine =
      skipped > 0
        ? `图片：共 ${summary.images.total} 张，已附带 ${summary.images.included} 张，跳过 ${skipped} 张`
        : `图片：共 ${summary.images.total} 张，已附带 ${summary.images.included} 张`;
    lines.push(imageLine);
    for (const name of summary.images.names) {
      lines.push(`- ${name}`);
    }
  }
  if (summary.audio) {
    const missing = Math.max(0, summary.audio.total - summary.audio.transcribed);
    const audioLine =
      missing > 0
        ? `语音：共 ${summary.audio.total} 条，已转写 ${summary.audio.transcribed} 条，未转写 ${missing} 条`
        : `语音：共 ${summary.audio.total} 条，已转写 ${summary.audio.transcribed} 条`;
    lines.push(audioLine);
    for (const item of summary.audio.items) {
      lines.push(`- ${item.name}: ${item.summary}`);
    }
  }
  lines.push("[/CodeHarbor 多模态摘要]");
  return lines.join("\n");
}

function renderMultimodalSummaryHtml(summary: OutboundMultimodalSummary): string {
  const blocks: string[] = [];
  blocks.push(`<p><font color="#805200"><b>多模态摘要</b></font></p>`);

  if (summary.images) {
    const skipped = Math.max(0, summary.images.total - summary.images.included);
    const imageText =
      skipped > 0
        ? `共 ${summary.images.total} 张，已附带 ${summary.images.included} 张，跳过 ${skipped} 张`
        : `共 ${summary.images.total} 张，已附带 ${summary.images.included} 张`;
    blocks.push(`<p><b>图片</b>：${escapeHtml(imageText)}</p>`);
    if (summary.images.names.length > 0) {
      blocks.push(`<ul>${summary.images.names.map((name) => `<li>${escapeHtml(name)}</li>`).join("")}</ul>`);
    }
  }

  if (summary.audio) {
    const missing = Math.max(0, summary.audio.total - summary.audio.transcribed);
    const audioText =
      missing > 0
        ? `共 ${summary.audio.total} 条，已转写 ${summary.audio.transcribed} 条，未转写 ${missing} 条`
        : `共 ${summary.audio.total} 条，已转写 ${summary.audio.transcribed} 条`;
    blocks.push(`<p><b>语音</b>：${escapeHtml(audioText)}</p>`);
    if (summary.audio.items.length > 0) {
      blocks.push(
        `<ul>${summary.audio.items.map((item) => `<li>${escapeHtml(item.name)}：${escapeHtml(item.summary)}</li>`).join("")}</ul>`,
      );
    }
  }

  return blocks.join("");
}

function buildRequestIdText(requestId: string): string {
  return `requestId: ${requestId}`;
}

function renderRequestIdHtml(requestId: string): string {
  return `<p><code>${escapeHtml(buildRequestIdText(requestId))}</code></p>`;
}

function normalizeMultimodalSummary(summary: OutboundMultimodalSummary | null): OutboundMultimodalSummary | null {
  if (!summary || typeof summary !== "object") {
    return null;
  }

  const images = normalizeImageSummary(summary.images);
  const audio = normalizeAudioSummary(summary.audio);
  if (!images && !audio) {
    return null;
  }
  return { images, audio };
}

function normalizeRequestId(requestId: string | null): string | null {
  if (typeof requestId !== "string") {
    return null;
  }
  const normalized = requestId.trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > 240 ? normalized.slice(0, 240) : normalized;
}

function normalizeImageSummary(
  summary: OutboundMultimodalSummary["images"],
): OutboundMultimodalSummary["images"] {
  if (!summary || typeof summary !== "object") {
    return null;
  }
  const total = normalizeCount(summary.total);
  const included = normalizeCount(summary.included);
  if (total === null || included === null) {
    return null;
  }
  const names = Array.isArray(summary.names)
    ? summary.names
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .slice(0, 6)
    : [];
  return {
    total,
    included: Math.min(total, included),
    names,
  };
}

function normalizeAudioSummary(
  summary: OutboundMultimodalSummary["audio"],
): OutboundMultimodalSummary["audio"] {
  if (!summary || typeof summary !== "object") {
    return null;
  }
  const total = normalizeCount(summary.total);
  const transcribed = normalizeCount(summary.transcribed);
  if (total === null || transcribed === null) {
    return null;
  }
  const items: OutboundMultimodalAudioSummary["items"] = Array.isArray(summary.items)
    ? summary.items
        .filter((item): item is OutboundMultimodalAudioSummary["items"][number] => {
          return Boolean(
            item &&
              typeof item === "object" &&
              typeof item.name === "string" &&
              item.name.trim() &&
              typeof item.summary === "string" &&
              item.summary.trim(),
          );
        })
        .map((item) => ({
          name: item.name.trim(),
          summary: item.summary.trim(),
        }))
        .slice(0, 4)
    : [];
  return {
    total,
    transcribed: Math.min(total, transcribed),
    items,
  };
}

function normalizeCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function renderMarkdownSection(raw: string): string {
  if (!raw.trim()) {
    return "";
  }

  const lines = raw.replace(/\r\n/g, "\n").trim().split("\n");
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const namedOutputBlock = collectNamedOutputBlock(lines, index);
    if (namedOutputBlock) {
      blocks.push(renderNamedOutputBlock(namedOutputBlock.label, namedOutputBlock.content));
      index += namedOutputBlock.consumedLines;
      continue;
    }

    const codeHarborEnvelope = parseCodeHarborEnvelopeLine(trimmed);
    if (codeHarborEnvelope) {
      blocks.push(renderCodeHarborEnvelopeLine(codeHarborEnvelope));
      index += 1;
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length + 1);
      blocks.push(`<h${level}>${renderInlineMarkup(headingMatch[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push("<hr/>");
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const current = lines[index].trim();
        if (!current) {
          break;
        }
        if (!/^>\s?/.test(current)) {
          break;
        }
        quoteLines.push(current.replace(/^>\s?/, ""));
        index += 1;
      }
      if (quoteLines.length > 0) {
        blocks.push(`<blockquote><p>${quoteLines.map((entry) => renderInlineMarkup(entry)).join("<br/>")}</p></blockquote>`);
      }
      continue;
    }

    const structuredRows = collectStructuredInfoRows(lines, index);
    if (structuredRows.length >= 2) {
      blocks.push(renderStructuredInfoRows(structuredRows));
      index += structuredRows.length;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, "").trim());
        index += 1;
      }
      blocks.push(`<ul>${items.map((item) => `<li>${renderInlineMarkup(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, "").trim());
        index += 1;
      }
      blocks.push(`<ol>${items.map((item) => `<li>${renderInlineMarkup(item)}</li>`).join("")}</ol>`);
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      if (!current.trim()) {
        break;
      }
      if (isBlockBoundaryLine(current)) {
        break;
      }
      paragraphLines.push(current.trimEnd());
      index += 1;
    }
    if (paragraphLines.length > 0) {
      blocks.push(`<p>${paragraphLines.map((entry) => renderInlineMarkup(entry)).join("<br/>")}</p>`);
      continue;
    }

    index += 1;
  }

  return blocks.join("");
}

interface StructuredInfoRow {
  key: string;
  value: string;
}

interface CodeHarborEnvelopeLine {
  source: string;
  tags: string[];
  keyValues: StructuredInfoRow[];
  message: string;
}

function collectStructuredInfoRows(lines: string[], startIndex: number): StructuredInfoRow[] {
  const rows: StructuredInfoRow[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const parsed = parseStructuredInfoLine(lines[index] ?? "");
    if (!parsed) {
      break;
    }
    rows.push(parsed);
    index += 1;
  }
  return rows;
}

function collectNamedOutputBlock(
  lines: string[],
  startIndex: number,
): { label: string; content: string; consumedLines: number } | null {
  const openLine = lines[startIndex]?.trim() ?? "";
  const openMatch = /^\[([A-Za-z][A-Za-z0-9_.:-]{1,80})\]$/.exec(openLine);
  if (!openMatch) {
    return null;
  }

  const label = openMatch[1];
  const closeMarker = `[/${label}]`;
  let endIndex = startIndex + 1;
  while (endIndex < lines.length) {
    if ((lines[endIndex]?.trim() ?? "") === closeMarker) {
      break;
    }
    endIndex += 1;
  }
  if (endIndex >= lines.length) {
    return null;
  }

  return {
    label,
    content: lines.slice(startIndex + 1, endIndex).join("\n"),
    consumedLines: endIndex - startIndex + 1,
  };
}

function renderNamedOutputBlock(label: string, content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const rendered = normalized || "(empty)";
  return `<p><font color="#3558d1"><b>${escapeHtml(label)}</b></font></p><pre><code>${escapeHtml(rendered)}</code></pre>`;
}

function parseCodeHarborEnvelopeLine(line: string): CodeHarborEnvelopeLine | null {
  const trimmed = line.trim();
  const sourceMatch = /^\[(CodeHarbor(?:[^\]]*)?)\]\s*(.*)$/.exec(trimmed);
  if (!sourceMatch) {
    return null;
  }

  const source = sourceMatch[1]?.trim() || "CodeHarbor";
  let rest = sourceMatch[2]?.trim() ?? "";
  const tags: string[] = [];

  while (rest.startsWith("[")) {
    const tagMatch = /^\[([A-Za-z0-9_-]{2,40})\]\s*(.*)$/.exec(rest);
    if (!tagMatch) {
      break;
    }
    tags.push(tagMatch[1].toUpperCase());
    rest = tagMatch[2]?.trim() ?? "";
  }

  const keyValues: StructuredInfoRow[] = [];
  while (true) {
    const leadingWithComma = /^([A-Za-z][A-Za-z0-9_.-]{0,80})=([^\s,]+),\s*(.*)$/.exec(rest);
    if (leadingWithComma) {
      keyValues.push({
        key: leadingWithComma[1],
        value: leadingWithComma[2],
      });
      rest = leadingWithComma[3]?.trim() ?? "";
      continue;
    }

    const trailingWithMessage = /^([A-Za-z][A-Za-z0-9_.-]{0,80})=([^\s,]+)(?:\s+(.*))?$/.exec(rest);
    if (!trailingWithMessage) {
      break;
    }
    keyValues.push({
      key: trailingWithMessage[1],
      value: trailingWithMessage[2],
    });
    rest = trailingWithMessage[3]?.trim() ?? "";
    break;
  }

  return {
    source,
    tags,
    keyValues,
    message: rest,
  };
}

function renderCodeHarborEnvelopeLine(line: CodeHarborEnvelopeLine): string {
  const heading = [line.source, ...line.tags].join(" · ").trim();
  const blocks: string[] = [`<p><font color="#8a5a00"><b>${escapeHtml(heading)}</b></font></p>`];
  if (line.keyValues.length > 0) {
    const rows = [...line.keyValues];
    if (line.message) {
      rows.push({
        key: "message",
        value: line.message,
      });
    }
    blocks.push(renderStructuredInfoRows(rows));
    return blocks.join("");
  }
  if (line.message) {
    blocks.push(`<p>${renderInlineMarkup(line.message)}</p>`);
  }
  return blocks.join("");
}

function parseStructuredInfoLine(line: string): StructuredInfoRow | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/^[-*]\s+/, "");
  const colonIndex = normalized.indexOf(":");
  if (colonIndex <= 0) {
    return null;
  }
  const key = normalized.slice(0, colonIndex).trim();
  const value = normalized.slice(colonIndex + 1).trim();
  if (!key || /^[0-9]+$/.test(key)) {
    return null;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*$/.test(key) && value.startsWith("//")) {
    // Avoid treating protocol-like text (for example https://foo) as structured key/value.
    return null;
  }
  return {
    key,
    value: value || "N/A",
  };
}

function renderStructuredInfoRows(rows: StructuredInfoRow[]): string {
  const tableRows = rows
    .map(
      (row) =>
        `<tr><td><b>${renderInlineMarkup(row.key)}</b></td><td>${renderInlineMarkup(row.value)}</td></tr>`,
    )
    .join("");
  return `<table><tbody>${tableRows}</tbody></table>`;
}

function isBlockBoundaryLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  return (
    /^(#{1,6})\s+/.test(trimmed) ||
    /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed) ||
    /^>\s?/.test(trimmed) ||
    /^\[(CodeHarbor(?:[^\]]*)?)\]\s*/.test(trimmed) ||
    /^\[[A-Za-z][A-Za-z0-9_.:-]{1,80}\]$/.test(trimmed) ||
    /^\s*[-*]\s+/.test(trimmed) ||
    /^\s*\d+\.\s+/.test(trimmed)
  );
}

function renderInlineMarkup(raw: string): string {
  if (!raw) {
    return "";
  }

  const inlineCodeSegments: string[] = [];
  const withPlaceholders = raw.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const token = `@@CHCODE${inlineCodeSegments.length}@@`;
    inlineCodeSegments.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  let rendered = escapeHtml(withPlaceholders);
  rendered = rendered.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
    const safeUrl = sanitizeLinkUrl(url);
    if (!safeUrl) {
      return escapeHtml(label);
    }
    return `<a href="${escapeHtml(safeUrl)}">${escapeHtml(label)}</a>`;
  });
  rendered = rendered.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  rendered = rendered.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  rendered = rendered.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");

  for (let i = 0; i < inlineCodeSegments.length; i += 1) {
    rendered = rendered.replace(`@@CHCODE${i}@@`, inlineCodeSegments[i]);
  }

  return rendered;
}

function sanitizeLinkUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
