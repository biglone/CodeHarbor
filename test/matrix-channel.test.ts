import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

const createClientMock = vi.hoisted(() => vi.fn());

vi.mock("matrix-js-sdk", () => ({
  createClient: createClientMock,
  EventType: {
    RoomMessage: "m.room.message",
  },
  RoomEvent: {
    Timeline: "Room.timeline",
  },
  RoomMemberEvent: {
    Membership: "RoomMember.membership",
  },
  ClientEvent: {
    Sync: "sync",
  },
}));

import { MatrixChannel } from "../src/channels/matrix-channel";

class FakeMatrixClient extends EventEmitter {
  startClient = vi.fn((_options?: unknown) => {});
  stopClient = vi.fn(() => {});
  sendTextMessage = vi.fn(async () => {});
  sendNotice = vi.fn(async () => ({ event_id: "$notice-default" }));
  sendEvent = vi.fn(async () => ({ event_id: "$edited" }));
  sendTyping = vi.fn(async () => ({}));
  joinRoom = vi.fn(async (_roomId: string) => {});
  getRooms = vi.fn(() => [] as Array<{ roomId: string; getMyMembership: () => string }>);
  getSyncState = vi.fn(() => null as string | null);
}

const config = {
  matrixHomeserver: "https://matrix.example.com",
  matrixUserId: "@bot:example.com",
  matrixAccessToken: "token",
  matrixCommandPrefix: "!code",
  codexBin: "codex",
  codexModel: null,
  codexWorkdir: process.cwd(),
  codexDangerousBypass: false,
  codexExecTimeoutMs: 1_000,
  codexSandboxMode: null,
  codexApprovalPolicy: null,
  codexExtraArgs: [],
  codexExtraEnv: {},
  stateDbPath: "data/state.db",
  legacyStateJsonPath: "data/state.json",
  maxProcessedEventsPerSession: 200,
  maxSessionAgeDays: 30,
  maxSessions: 5000,
  replyChunkSize: 3500,
  matrixProgressUpdates: true,
  matrixProgressMinIntervalMs: 2500,
  matrixTypingTimeoutMs: 10_000,
  sessionActiveWindowMinutes: 20,
  defaultGroupTriggerPolicy: {
    allowMention: true,
    allowReply: true,
    allowActiveWindow: true,
    allowPrefix: true,
  },
  roomTriggerPolicies: {},
  rateLimiter: {
    windowMs: 60_000,
    maxRequestsPerUser: 20,
    maxRequestsPerRoom: 120,
    maxConcurrentGlobal: 8,
    maxConcurrentPerUser: 1,
    maxConcurrentPerRoom: 4,
  },
  cliCompat: {
    enabled: false,
    passThroughEvents: false,
    preserveWhitespace: false,
    disableReplyChunkSplit: false,
    progressThrottleMs: 300,
    fetchMedia: false,
    recordPath: null,
  },
  doctorHttpTimeoutMs: 10_000,
  logLevel: "info",
};

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("MatrixChannel", () => {
  it("starts successfully when sync event fires immediately after startClient", async () => {
    const client = new FakeMatrixClient();
    client.startClient.mockImplementation(() => {
      client.emit("sync", "SYNCING");
    });
    createClientMock.mockReturnValue(client);

    const channel = new MatrixChannel(config as never, logger as never);
    await expect(channel.start(async () => {})).resolves.toBeUndefined();
    await channel.stop();
  });

  it("joins pending invited rooms during startup", async () => {
    const client = new FakeMatrixClient();
    client.startClient.mockImplementation(() => {
      client.emit("sync", "PREPARED");
    });
    client.getRooms.mockReturnValue([
      {
        roomId: "!invite:example.com",
        getMyMembership: () => "invite",
      },
      {
        roomId: "!joined:example.com",
        getMyMembership: () => "join",
      },
    ]);
    createClientMock.mockReturnValue(client);

    const channel = new MatrixChannel(config as never, logger as never);
    await channel.start(async () => {});

    expect(client.joinRoom).toHaveBeenCalledWith("!invite:example.com");
    expect(client.joinRoom).toHaveBeenCalledTimes(1);
    await channel.stop();
  });

  it("forwards inbound metadata for direct room and bot mention", async () => {
    const client = new FakeMatrixClient();
    client.startClient.mockImplementation(() => {
      client.emit("sync", "PREPARED");
    });
    createClientMock.mockReturnValue(client);

    const channel = new MatrixChannel(config as never, logger as never);
    const handler = vi.fn(async (_message: unknown) => {});
    await channel.start(handler);

    const event = {
      getType: () => "m.room.message",
      getSender: () => "@alice:example.com",
      getContent: () => ({
        msgtype: "m.text",
        body: "@bot:example.com 帮我看看",
        "m.mentions": { user_ids: ["@bot:example.com"] },
      }),
      getId: () => "$event-1",
    };

    const room = {
      roomId: "!room:example.com",
      getJoinedMemberCount: () => 2,
      findEventById: (_eventId: string) => undefined,
    };

    client.emit("Room.timeline", event, room, false);
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      text: "@bot:example.com 帮我看看",
      attachments: [],
      isDirectMessage: true,
      mentionsBot: true,
      repliesToBot: false,
    });

    await channel.stop();
  });

  it("forwards attachment metadata for media messages", async () => {
    const client = new FakeMatrixClient();
    client.startClient.mockImplementation(() => {
      client.emit("sync", "PREPARED");
    });
    createClientMock.mockReturnValue(client);

    const channel = new MatrixChannel(config as never, logger as never);
    const handler = vi.fn(async (_message: unknown) => {});
    await channel.start(handler);

    const event = {
      getType: () => "m.room.message",
      getSender: () => "@alice:example.com",
      getContent: () => ({
        msgtype: "m.image",
        body: "diagram.png",
        url: "mxc://example.com/abc123",
        info: {
          mimetype: "image/png",
          size: 4096,
        },
      }),
      getId: () => "$event-image",
    };

    const room = {
      roomId: "!room:example.com",
      getJoinedMemberCount: () => 3,
      findEventById: (_eventId: string) => undefined,
    };

    client.emit("Room.timeline", event, room, false);
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      text: "diagram.png",
      attachments: [
        {
          kind: "image",
          name: "diagram.png",
          mxcUrl: "mxc://example.com/abc123",
          mimeType: "image/png",
          sizeBytes: 4096,
          localPath: null,
        },
      ],
    });

    await channel.stop();
  });

  it("edits existing group progress notice instead of sending new notice", async () => {
    const client = new FakeMatrixClient();
    client.startClient.mockImplementation(() => {
      client.emit("sync", "PREPARED");
    });
    client.sendNotice.mockResolvedValue({ event_id: "$notice-1" });
    createClientMock.mockReturnValue(client);

    const channel = new MatrixChannel(config as never, logger as never);
    await channel.start(async (_message: unknown) => {});

    const firstId = await channel.upsertProgressNotice("!room:example.com", "[CodeHarbor] thinking 1", null);
    const secondId = await channel.upsertProgressNotice("!room:example.com", "[CodeHarbor] thinking 2", firstId);

    expect(firstId).toBe("$notice-1");
    expect(secondId).toBe("$edited");
    expect(client.sendNotice).toHaveBeenCalledTimes(1);
    expect(client.sendEvent).toHaveBeenCalledTimes(1);

    await channel.stop();
  });
});
