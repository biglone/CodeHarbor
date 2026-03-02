import { createClient, MatrixClient } from "matrix-js-sdk";

import { AppConfig } from "../config";
import { Logger } from "../logger";
import { InboundMessage } from "../types";
import { extractCommandText, splitText } from "../utils/message";

export type InboundHandler = (message: InboundMessage) => Promise<void>;

export class MatrixChannel {
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly chunkSize: number;
  private readonly client: MatrixClient;
  private handler: InboundHandler | null = null;
  private started = false;

  constructor(config: AppConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.chunkSize = config.replyChunkSize;
    this.client = createClient({
      baseUrl: config.matrixHomeserver,
      accessToken: config.matrixAccessToken,
      userId: config.matrixUserId,
    });
  }

  async start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
    this.client.on("Room.timeline", this.onTimeline);
    this.client.on("RoomMember.membership", this.onMembership);
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

    for (const chunk of splitText(text, this.chunkSize)) {
      await this.client.sendEvent(
        conversationId,
        "m.room.message",
        {
          msgtype: "m.text",
          body: chunk,
        },
        "",
      );
    }
  }

  async stop(): Promise<void> {
    this.client.removeListener("Room.timeline", this.onTimeline);
    this.client.removeListener("RoomMember.membership", this.onMembership);
    this.client.stopClient();
    this.started = false;
  }

  private readonly onMembership = (_event: any, member: any): void => {
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

  private readonly onTimeline = (event: any, room: any, toStartOfTimeline: boolean): void => {
    if (!this.handler || !room || toStartOfTimeline) {
      return;
    }
    if (event.getType() !== "m.room.message") {
      return;
    }
    if (event.getSender() === this.config.matrixUserId) {
      return;
    }

    const content = event.getContent();
    if (!content || content.msgtype !== "m.text" || typeof content.body !== "string") {
      return;
    }

    const commandText = extractCommandText(content.body, this.config.matrixCommandPrefix);
    if (!commandText) {
      return;
    }

    const eventId = event.getId();
    if (!eventId || typeof eventId !== "string") {
      return;
    }

    const inbound: InboundMessage = {
      channel: "matrix",
      conversationId: room.roomId,
      senderId: event.getSender(),
      eventId,
      text: commandText,
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

      const onSync = (state: string): void => {
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
        this.client.removeListener("sync", onSync);
      };

      this.client.on("sync", onSync);
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
