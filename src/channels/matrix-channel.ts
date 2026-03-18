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
import { InboundAttachment, InboundMessage } from "../types";
import { splitText } from "../utils/message";
import { Channel, type InboundHandler } from "./channel";

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

  async sendMessage(conversationId: string, text: string): Promise<void> {
    if (!this.started) {
      throw new Error("Matrix channel not started.");
    }

    const chunks = this.splitReplies ? splitText(text, this.chunkSize) : [text];
    for (const chunk of chunks) {
      await this.sendRichText(conversationId, chunk, "m.text");
    }
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
        buildMatrixRichMessageContent(normalized, "m.notice"),
      );
      return response.event_id;
    }

    const content = {
      msgtype: "m.notice",
      body: `* ${normalized}`,
      "m.new_content": {
        msgtype: "m.notice",
        body: normalized,
      },
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
  ): Promise<void> {
    const payload = buildMatrixRichMessageContent(text, msgtype);
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
        retryableStatuses: DEFAULT_RETRYABLE_HTTP_STATUSES,
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

  private async hydrateAttachments(
    attachments: InboundAttachment[],
    eventId: string,
  ): Promise<InboundAttachment[]> {
    if (!this.fetchMedia || attachments.length === 0) {
      return attachments;
    }

    const hydrated = await Promise.all(
      attachments.map(async (attachment, index) => {
        if (!shouldHydrateAttachment(attachment.kind, this.transcribeAudio) || !attachment.mxcUrl) {
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
          retryableStatuses: DEFAULT_RETRYABLE_HTTP_STATUSES,
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
  return body.includes(botUserId);
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

function shouldHydrateAttachment(kind: InboundAttachment["kind"], transcribeAudio: boolean): boolean {
  if (kind === "image") {
    return true;
  }
  if (kind === "audio") {
    return transcribeAudio;
  }
  return false;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function resolveFileExtension(fileName: string, mimeType: string | null): string {
  const ext = path.extname(fileName).trim();
  if (ext) {
    return ext;
  }
  if (mimeType === "image/png") {
    return ".png";
  }
  if (mimeType === "image/jpeg") {
    return ".jpg";
  }
  if (mimeType === "image/webp") {
    return ".webp";
  }
  if (mimeType === "audio/mpeg") {
    return ".mp3";
  }
  if (mimeType === "audio/mp4" || mimeType === "audio/x-m4a") {
    return ".m4a";
  }
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") {
    return ".wav";
  }
  if (mimeType === "audio/ogg") {
    return ".ogg";
  }
  if (mimeType === "audio/flac") {
    return ".flac";
  }
  return ".bin";
}

function buildMatrixRichMessageContent(
  body: string,
  msgtype: "m.text" | "m.notice",
): Record<string, unknown> {
  return {
    msgtype,
    body,
    format: "org.matrix.custom.html",
    formatted_body: renderMatrixHtml(body, msgtype),
  };
}

function renderMatrixHtml(body: string, msgtype: "m.text" | "m.notice"): string {
  const normalized = body.replace(/\r\n/g, "\n");
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
    sections.push(
      `<p><font color="#3558d1"><b>${label}</b></font></p><pre><code>${code}</code></pre>`,
    );

    cursor = match.index + match[0].length;
  }

  const tail = normalized.slice(cursor);
  const renderedTail = renderMarkdownSection(tail);
  if (renderedTail) {
    sections.push(renderedTail);
  }

  if (sections.length === 0) {
    sections.push("<p>(空消息)</p>");
  }

  const badge =
    msgtype === "m.notice"
      ? `<p><font color="#8a5a00"><b>CodeHarbor 提示</b></font></p>`
      : `<p><font color="#1f7a5a"><b>CodeHarbor AI 回复</b></font></p>`;

  return `<div>${badge}${sections.join("")}</div>`;
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

function isBlockBoundaryLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  return (
    /^(#{1,6})\s+/.test(trimmed) ||
    /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed) ||
    /^>\s?/.test(trimmed) ||
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
