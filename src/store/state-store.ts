import fs from "node:fs";
import path from "node:path";

import { SessionState, StateData } from "../types";

const EMPTY_STATE: StateData = { sessions: {} };
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class StateStore {
  private readonly filePath: string;
  private readonly maxProcessedEventsPerSession: number;
  private readonly maxSessionAgeMs: number;
  private readonly persistDebounceMs: number;
  private data: StateData;
  private lastPruneAt = 0;
  private pendingPersist = false;
  private persistTimer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    filePath: string,
    maxProcessedEventsPerSession: number,
    maxSessionAgeDays: number,
    persistDebounceMs = 30,
  ) {
    this.filePath = filePath;
    this.maxProcessedEventsPerSession = maxProcessedEventsPerSession;
    this.maxSessionAgeMs = maxSessionAgeDays * ONE_DAY_MS;
    this.persistDebounceMs = persistDebounceMs;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.data = this.load();
    if (this.pruneExpiredSessions()) {
      this.schedulePersist();
    }
  }

  getCodexSessionId(sessionKey: string): string | null {
    return this.ensureSession(sessionKey).codexSessionId;
  }

  setCodexSessionId(sessionKey: string, codexSessionId: string): void {
    this.maybePruneExpiredSessions();
    const session = this.ensureSession(sessionKey);
    session.codexSessionId = codexSessionId;
    session.updatedAt = new Date().toISOString();
    this.schedulePersist();
  }

  markEventIfNew(sessionKey: string, eventId: string): boolean {
    this.maybePruneExpiredSessions();
    const session = this.ensureSession(sessionKey);
    if (session.processedEventIds.includes(eventId)) {
      return false;
    }

    session.processedEventIds.push(eventId);
    if (session.processedEventIds.length > this.maxProcessedEventsPerSession) {
      const offset = session.processedEventIds.length - this.maxProcessedEventsPerSession;
      session.processedEventIds = session.processedEventIds.slice(offset);
    }
    session.updatedAt = new Date().toISOString();
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.triggerFlush();
    await this.writeChain;
  }

  private ensureSession(sessionKey: string): SessionState {
    if (!this.data.sessions[sessionKey]) {
      this.data.sessions[sessionKey] = {
        codexSessionId: null,
        processedEventIds: [],
        updatedAt: new Date().toISOString(),
      };
    }
    return this.data.sessions[sessionKey];
  }

  private load(): StateData {
    if (!fs.existsSync(this.filePath)) {
      this.writeFile(EMPTY_STATE);
      return structuredClone(EMPTY_STATE);
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StateData;
      if (!parsed.sessions || typeof parsed.sessions !== "object") {
        throw new Error("Malformed state data.");
      }
      return parsed;
    } catch {
      this.writeFile(EMPTY_STATE);
      return structuredClone(EMPTY_STATE);
    }
  }

  private maybePruneExpiredSessions(): void {
    const now = Date.now();
    const pruneIntervalMs = 5 * 60 * 1000;
    if (now - this.lastPruneAt < pruneIntervalMs) {
      return;
    }
    this.lastPruneAt = now;
    if (this.pruneExpiredSessions(now)) {
      this.schedulePersist();
    }
  }

  private pruneExpiredSessions(now = Date.now()): boolean {
    if (this.maxSessionAgeMs <= 0) {
      return false;
    }

    let changed = false;
    for (const [sessionKey, session] of Object.entries(this.data.sessions)) {
      const updatedAt = Date.parse(session.updatedAt);
      if (!Number.isFinite(updatedAt)) {
        continue;
      }
      if (now - updatedAt > this.maxSessionAgeMs) {
        delete this.data.sessions[sessionKey];
        changed = true;
      }
    }
    return changed;
  }

  private schedulePersist(): void {
    this.pendingPersist = true;
    if (this.persistTimer) {
      return;
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.triggerFlush();
    }, this.persistDebounceMs);
    this.persistTimer.unref?.();
  }

  private triggerFlush(): void {
    this.writeChain = this.writeChain.then(() => this.flushPending());
  }

  private async flushPending(): Promise<void> {
    if (!this.pendingPersist) {
      return;
    }
    this.pendingPersist = false;
    const serialized = JSON.stringify(this.data, null, 2);
    await this.writeSerialized(serialized);

    if (this.pendingPersist) {
      await this.flushPending();
    }
  }

  private writeFile(data: StateData): void {
    const serialized = JSON.stringify(data, null, 2);
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, serialized);
    fs.renameSync(tmpPath, this.filePath);
  }

  private async writeSerialized(serialized: string): Promise<void> {
    const tmpPath = `${this.filePath}.tmp`;
    await fs.promises.writeFile(tmpPath, serialized);
    await fs.promises.rename(tmpPath, this.filePath);
  }
}
