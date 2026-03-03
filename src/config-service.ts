import fs from "node:fs";
import path from "node:path";

import { TriggerPolicy } from "./config";
import {
  RoomSettingsRecord,
  RoomSettingsUpsertInput,
  StateStore,
} from "./store/state-store";

export interface RoomConfigResolved {
  source: "default" | "room";
  enabled: boolean;
  triggerPolicy: TriggerPolicy;
  workdir: string;
}

export interface RoomSettingsUpdateInput {
  roomId: string;
  enabled: boolean;
  allowMention: boolean;
  allowReply: boolean;
  allowActiveWindow: boolean;
  allowPrefix: boolean;
  workdir: string;
  actor?: string | null;
  summary?: string | null;
}

export class ConfigService {
  private readonly stateStore: StateStore;
  private readonly defaultWorkdir: string;

  constructor(stateStore: StateStore, defaultWorkdir: string) {
    this.stateStore = stateStore;
    this.defaultWorkdir = path.resolve(defaultWorkdir);
  }

  resolveRoomConfig(roomId: string, fallbackPolicy: TriggerPolicy): RoomConfigResolved {
    const room = this.stateStore.getRoomSettings(roomId);
    if (!room) {
      return {
        source: "default",
        enabled: true,
        triggerPolicy: fallbackPolicy,
        workdir: this.defaultWorkdir,
      };
    }

    return {
      source: "room",
      enabled: room.enabled,
      triggerPolicy: {
        allowMention: room.allowMention,
        allowReply: room.allowReply,
        allowActiveWindow: room.allowActiveWindow,
        allowPrefix: room.allowPrefix,
      },
      workdir: room.workdir,
    };
  }

  getRoomSettings(roomId: string): RoomSettingsRecord | null {
    return this.stateStore.getRoomSettings(roomId);
  }

  listRoomSettings(): RoomSettingsRecord[] {
    return this.stateStore.listRoomSettings();
  }

  updateRoomSettings(input: RoomSettingsUpdateInput): RoomSettingsRecord {
    const normalized = normalizeRoomSettingsInput(input);
    this.stateStore.upsertRoomSettings(normalized);

    const revisionPayload = JSON.stringify({
      type: "room_settings_upsert",
      roomId: normalized.roomId,
      enabled: normalized.enabled,
      allowMention: normalized.allowMention,
      allowReply: normalized.allowReply,
      allowActiveWindow: normalized.allowActiveWindow,
      allowPrefix: normalized.allowPrefix,
      workdir: normalized.workdir,
    });
    const summary = input.summary?.trim() || `upsert room settings for ${normalized.roomId}`;
    const actor = input.actor?.trim() || null;
    this.stateStore.appendConfigRevision(actor, summary, revisionPayload);

    const latest = this.stateStore.getRoomSettings(normalized.roomId);
    if (!latest) {
      throw new Error(`Failed to persist room settings for ${normalized.roomId}`);
    }
    return latest;
  }

  deleteRoomSettings(roomId: string, actor?: string | null): void {
    const normalizedRoomId = roomId.trim();
    if (!normalizedRoomId) {
      throw new Error("roomId is required.");
    }
    this.stateStore.deleteRoomSettings(normalizedRoomId);
    const summary = `delete room settings for ${normalizedRoomId}`;
    const payload = JSON.stringify({
      type: "room_settings_delete",
      roomId: normalizedRoomId,
    });
    this.stateStore.appendConfigRevision(actor?.trim() || null, summary, payload);
  }
}

function normalizeRoomSettingsInput(input: RoomSettingsUpdateInput): RoomSettingsUpsertInput {
  const roomId = input.roomId.trim();
  if (!roomId) {
    throw new Error("roomId is required.");
  }

  const workdir = path.resolve(input.workdir);
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    throw new Error(`workdir does not exist or is not a directory: ${workdir}`);
  }

  return {
    roomId,
    enabled: input.enabled,
    allowMention: input.allowMention,
    allowReply: input.allowReply,
    allowActiveWindow: input.allowActiveWindow,
    allowPrefix: input.allowPrefix,
    workdir,
  };
}
