import {
  ClientEvent,
  createClient,
  EventType,
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
import { InboundAttachment, InboundMessage } from "../types";
import { splitText } from "../utils/message";

export type InboundHandler = (message: InboundMessage) => Promise<void>;

export class MatrixChannel {
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly chunkSize: number;
  private readonly splitReplies: boolean;
  private readonly preserveWhitespace: boolean;
  private readonly client: MatrixClient;
  private handler: InboundHandler | null = null;
  private started = false;

  constructor(config: AppConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.chunkSize = config.replyChunkSize;
    this.splitReplies = !config.cliCompat.disableReplyChunkSplit;
    this.preserveWhitespace = config.cliCompat.preserveWhitespace;
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
      await this.client.sendTextMessage(conversationId, chunk);
    }
  }

  async sendNotice(conversationId: string, text: string): Promise<void> {
    if (!this.started) {
      throw new Error("Matrix channel not started.");
    }

    const chunks = this.splitReplies ? splitText(text, this.chunkSize) : [text];
    for (const chunk of chunks) {
      await this.client.sendNotice(conversationId, chunk);
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
      const response = await this.client.sendNotice(conversationId, normalized);
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

    const sendEditEvent = this.client.sendEvent as unknown as (
      roomId: string,
      eventType: string,
      payload: Record<string, unknown>,
    ) => Promise<{ event_id: string }>;
    const response = await sendEditEvent(conversationId, EventType.RoomMessage, content as Record<string, unknown>);
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
    if (!senderId || senderId === this.config.matrixUserId) {
      return;
    }

    const content = event.getContent();
    if (!content || typeof content !== "object") {
      return;
    }

    const msgtype = typeof content.msgtype === "string" ? content.msgtype : "";
    const acceptedMsgtypes = new Set(["m.text", "m.image", "m.file", "m.audio", "m.video"]);
    if (!acceptedMsgtypes.has(msgtype)) {
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

    const inbound: InboundMessage = {
      requestId: buildRequestId(eventId),
      channel: "matrix",
      conversationId: room.roomId,
      senderId,
      eventId,
      text,
      attachments,
      isDirectMessage,
      mentionsBot,
      repliesToBot,
    };

    void this.handler(inbound).catch((error) => {
      this.logger.error("Unhandled inbound processing error", error);
    });
  };

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
}

function buildRequestId(eventId: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${eventId}:${suffix}`;
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
    },
  ];
}
