import { EventEmitter } from "node:events";
import fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createClientMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

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
import { DEFAULT_DOCUMENT_MAX_BYTES } from "../src/document-extractor";

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
    transcribeAudio: false,
    audioTranscribeModel: "gpt-4o-mini-transcribe",
    audioTranscribeTimeoutMs: 120000,
    audioTranscribeMaxChars: 6000,
    audioTranscribeMaxRetries: 1,
    audioTranscribeRetryDelayMs: 800,
    audioTranscribeMaxBytes: 26214400,
    audioLocalWhisperCommand: null,
    audioLocalWhisperTimeoutMs: 180000,
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

function createSendResponse(eventId: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ event_id: eventId }),
  } as unknown as Response;
}

function createErrorResponse(status: number, statusText = "Error", body = "failed"): Response {
  return {
    ok: false,
    status,
    statusText,
    text: async () => body,
    json: async () => ({ error: body }),
  } as unknown as Response;
}

function createMediaResponse(body = "media-payload"): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () => Buffer.from(body),
  } as unknown as Response;
}

describe("MatrixChannel", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(createSendResponse("$event-default"));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("hydrates audio attachment to local file when transcription is enabled", async () => {
    const client = new FakeMatrixClient();
    client.startClient.mockImplementation(() => {
      client.emit("sync", "PREPARED");
    });
    createClientMock.mockReturnValue(client);
    fetchMock.mockResolvedValue(createMediaResponse());

    const channel = new MatrixChannel(
      {
        ...config,
        cliCompat: {
          ...config.cliCompat,
          fetchMedia: true,
          transcribeAudio: true,
        },
      } as never,
      logger as never,
    );
    const handler = vi.fn(async (_message: unknown) => {});
    await channel.start(handler);

    const event = {
      getType: () => "m.room.message",
      getSender: () => "@alice:example.com",
      getContent: () => ({
        msgtype: "m.audio",
        body: "voice.m4a",
        url: "mxc://example.com/audio123",
        info: {
          mimetype: "audio/mp4",
          size: 2048,
        },
      }),
      getId: () => "$event-audio",
    };

    const room = {
      roomId: "!room:example.com",
      getJoinedMemberCount: () => 2,
      findEventById: (_eventId: string) => undefined,
    };

    client.emit("Room.timeline", event, room, false);
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });
    const message = handler.mock.calls[0]?.[0] as { attachments: Array<{ localPath: string | null }> };
    const localPath = message.attachments[0]?.localPath;
    expect(localPath).toBeTruthy();
    expect(localPath).toContain("codeharbor-media");
    expect(localPath).toMatch(/\.m4a$/);
    if (localPath) {
      await fs.unlink(localPath).catch(() => {});
    }

    await channel.stop();
  });

  it("hydrates supported document attachment when media fetch is enabled", async () => {
    const client = new FakeMatrixClient();
    client.startClient.mockImplementation(() => {
      client.emit("sync", "PREPARED");
    });
    createClientMock.mockReturnValue(client);
    fetchMock.mockResolvedValue(createMediaResponse("pdf-bytes"));

    const channel = new MatrixChannel(
      {
        ...config,
        cliCompat: {
          ...config.cliCompat,
          fetchMedia: true,
        },
      } as never,
      logger as never,
    );
    const handler = vi.fn(async (_message: unknown) => {});
    await channel.start(handler);

    const event = {
      getType: () => "m.room.message",
      getSender: () => "@alice:example.com",
      getContent: () => ({
        msgtype: "m.file",
        body: "plan.pdf",
        url: "mxc://example.com/doc123",
        info: {
          mimetype: "application/pdf",
          size: 2048,
        },
      }),
      getId: () => "$event-doc",
    };

    const room = {
      roomId: "!room:example.com",
      getJoinedMemberCount: () => 2,
      findEventById: (_eventId: string) => undefined,
    };

    client.emit("Room.timeline", event, room, false);
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    const message = handler.mock.calls[0]?.[0] as { attachments: Array<{ localPath: string | null }> };
    const localPath = message.attachments[0]?.localPath;
    expect(localPath).toBeTruthy();
    expect(localPath).toContain("codeharbor-media");
    expect(localPath).toMatch(/\.pdf$/);
    if (localPath) {
      await fs.unlink(localPath).catch(() => {});
    }

    await channel.stop();
  });

  it("keeps unsupported or oversized document attachments as metadata only", async () => {
    const client = new FakeMatrixClient();
    client.startClient.mockImplementation(() => {
      client.emit("sync", "PREPARED");
    });
    createClientMock.mockReturnValue(client);

    const channel = new MatrixChannel(
      {
        ...config,
        cliCompat: {
          ...config.cliCompat,
          fetchMedia: true,
        },
      } as never,
      logger as never,
    );
    const handler = vi.fn(async (_message: unknown) => {});
    await channel.start(handler);

    const room = {
      roomId: "!room:example.com",
      getJoinedMemberCount: () => 2,
      findEventById: (_eventId: string) => undefined,
    };

    client.emit(
      "Room.timeline",
      {
        getType: () => "m.room.message",
        getSender: () => "@alice:example.com",
        getContent: () => ({
          msgtype: "m.file",
          body: "notes.md",
          url: "mxc://example.com/md123",
          info: {
            mimetype: "text/markdown",
            size: 128,
          },
        }),
        getId: () => "$event-doc-unsupported",
      },
      room,
      false,
    );
    client.emit(
      "Room.timeline",
      {
        getType: () => "m.room.message",
        getSender: () => "@alice:example.com",
        getContent: () => ({
          msgtype: "m.file",
          body: "large.pdf",
          url: "mxc://example.com/pdf-large",
          info: {
            mimetype: "application/pdf",
            size: DEFAULT_DOCUMENT_MAX_BYTES + 1,
          },
        }),
        getId: () => "$event-doc-large",
      },
      room,
      false,
    );

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(2);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const firstMessage = handler.mock.calls[0]?.[0] as { attachments: Array<{ localPath: string | null }> };
    const secondMessage = handler.mock.calls[1]?.[0] as { attachments: Array<{ localPath: string | null }> };
    expect(firstMessage.attachments[0]?.localPath).toBeNull();
    expect(secondMessage.attachments[0]?.localPath).toBeNull();

    await channel.stop();
  });

  it("edits existing group progress notice instead of sending new notice", async () => {
    const client = new FakeMatrixClient();
    client.startClient.mockImplementation(() => {
      client.emit("sync", "PREPARED");
    });
    fetchMock
      .mockResolvedValueOnce(createSendResponse("$notice-1"))
      .mockResolvedValueOnce(createSendResponse("$edited"));
    createClientMock.mockReturnValue(client);

    const channel = new MatrixChannel(config as never, logger as never);
    await channel.start(async (_message: unknown) => {});

    const firstId = await channel.upsertProgressNotice("!room:example.com", "[CodeHarbor] thinking 1", null);
    const secondId = await channel.upsertProgressNotice("!room:example.com", "[CodeHarbor] thinking 2", firstId);

    expect(firstId).toBe("$notice-1");
    expect(secondId).toBe("$edited");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstPayload = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1]?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    expect(firstPayload).toMatchObject({
      msgtype: "m.notice",
      body: "[CodeHarbor] thinking 1",
      format: "org.matrix.custom.html",
    });
    const secondPayload = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1]?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    expect(secondPayload).toMatchObject({
      msgtype: "m.notice",
      body: "* [CodeHarbor] thinking 2",
      "m.relates_to": {
        rel_type: "m.replace",
        event_id: "$notice-1",
      },
    });

    await channel.stop();
  });

  it("retries transient send failures before succeeding", async () => {
    const client = new FakeMatrixClient();
    client.startClient.mockImplementation(() => {
      client.emit("sync", "PREPARED");
    });
    fetchMock
      .mockResolvedValueOnce(createErrorResponse(503, "Service Unavailable", "temporary"))
      .mockResolvedValueOnce(createSendResponse("$retry-ok"));
    createClientMock.mockReturnValue(client);

    const channel = new MatrixChannel(config as never, logger as never);
    await channel.start(async (_message: unknown) => {});

    await channel.sendMessage("!room:example.com", "retry me");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/send/m.room.message/");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/send/m.room.message/");

    await channel.stop();
  });

  it("sends rich html for AI chat replies", async () => {
    const client = new FakeMatrixClient();
    client.startClient.mockImplementation(() => {
      client.emit("sync", "PREPARED");
    });
    createClientMock.mockReturnValue(client);

    const channel = new MatrixChannel(config as never, logger as never);
    await channel.start(async (_message: unknown) => {});

    const reply = [
      "# 会话结果",
      "",
      "- 完成 **发布**",
      "- 查看 [CodeHarbor](https://github.com/biglone/CodeHarbor)",
      "",
      "> 保持小步提交",
      "",
      "这是普通文本，含 `inline` 代码。",
      "",
      "```ts",
      "const answer = 42;",
      "```",
    ].join("\n");

    await channel.sendMessage("!room:example.com", reply);

    expect(client.sendTextMessage).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstSendCall = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(firstSendCall[0]).toContain(
      "/_matrix/client/v3/rooms/!room%3Aexample.com/send/m.room.message/codeharbor-",
    );
    expect(firstSendCall[1]?.method).toBe("PUT");
    const payload = JSON.parse(String(firstSendCall[1]?.body ?? "{}")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      msgtype: "m.text",
      body: reply,
      format: "org.matrix.custom.html",
    });
    const formatted = String(payload.formatted_body ?? "");
    expect(formatted).toContain("CodeHarbor AI 回复");
    expect(formatted).toContain("<h2>会话结果</h2>");
    expect(formatted).toContain("<ul><li>完成 <strong>发布</strong></li>");
    expect(formatted).toContain('<a href="https://github.com/biglone/CodeHarbor">CodeHarbor</a>');
    expect(formatted).toContain("<blockquote><p>保持小步提交</p></blockquote>");
    expect(formatted).toContain("<code>inline</code>");
    expect(formatted).toContain("<pre><code>const answer = 42;");

    await channel.stop();
  });
});
