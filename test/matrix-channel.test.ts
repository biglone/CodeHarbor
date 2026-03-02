import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

const createClientMock = vi.hoisted(() => vi.fn());

vi.mock("matrix-js-sdk", () => ({
  createClient: createClientMock,
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
  statePath: "data/state.json",
  maxProcessedEventsPerSession: 200,
  maxSessionAgeDays: 30,
  maxSessions: 5000,
  replyChunkSize: 3500,
  matrixProgressUpdates: true,
  matrixProgressMinIntervalMs: 2500,
  matrixTypingTimeoutMs: 10_000,
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
});
