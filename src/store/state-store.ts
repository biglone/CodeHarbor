import fs from "node:fs";
import path from "node:path";

import { SessionState, StateData } from "../types";

const EMPTY_STATE: StateData = { sessions: {} };
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class StateStore {
  private readonly filePath: string;
  private readonly maxProcessedEventsPerSession: number;
  private readonly maxSessionAgeMs: number;
  private readonly maxSessions: number;
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
    maxSessions: number,
    persistDebounceMs = 30,
  ) {
    this.filePath = filePath;
    this.maxProcessedEventsPerSession = maxProcessedEventsPerSession;
    this.maxSessionAgeMs = maxSessionAgeDays * ONE_DAY_MS;
    this.maxSessions = maxSessions;
    this.persistDebounceMs = persistDebounceMs;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.data = this.load();
    if (this.pruneSessions()) {
      this.schedulePersist();
    }
  }

  getCodexSessionId(sessionKey: string): string | null {
    const session = this.data.sessions[sessionKey];
    return session?.codexSessionId ?? null;
  }

  setCodexSessionId(sessionKey: string, codexSessionId: string): void {
    this.maybePruneExpiredSessions();
    const session = this.ensureSession(sessionKey);
    session.codexSessionId = codexSessionId;
    session.updatedAt = new Date().toISOString();
    this.schedulePersist();
  }

  clearCodexSessionId(sessionKey: string): void {
    this.maybePruneExpiredSessions();
    const session = this.ensureSession(sessionKey);
    session.codexSessionId = null;
    session.updatedAt = new Date().toISOString();
    this.schedulePersist();
  }

  isSessionActive(sessionKey: string, now = Date.now()): boolean {
    this.maybePruneExpiredSessions();
    const session = this.data.sessions[sessionKey];
    if (!session || !session.activeUntil) {
      return false;
    }
    const activeUntilTs = Date.parse(session.activeUntil);
    if (!Number.isFinite(activeUntilTs)) {
      return false;
    }
    return now <= activeUntilTs;
  }

  activateSession(sessionKey: string, activeWindowMs: number): void {
    this.maybePruneExpiredSessions();
    const session = this.ensureSession(sessionKey);
    const activeUntil = new Date(Date.now() + Math.max(0, activeWindowMs)).toISOString();
    session.activeUntil = activeUntil;
    session.updatedAt = new Date().toISOString();
    this.schedulePersist();
  }

  deactivateSession(sessionKey: string): void {
    this.maybePruneExpiredSessions();
    const session = this.data.sessions[sessionKey];
    if (!session) {
      return;
    }
    session.activeUntil = null;
    session.updatedAt = new Date().toISOString();
    this.schedulePersist();
  }

  getSessionStatus(sessionKey: string): { hasCodexSession: boolean; activeUntil: string | null; isActive: boolean } {
    this.maybePruneExpiredSessions();
    const session = this.data.sessions[sessionKey];
    if (!session) {
      return {
        hasCodexSession: false,
        activeUntil: null,
        isActive: false,
      };
    }
    const isActive = session.activeUntil ? this.isSessionActive(sessionKey) : false;
    return {
      hasCodexSession: Boolean(session.codexSessionId),
      activeUntil: session.activeUntil,
      isActive,
    };
  }

  hasProcessedEvent(sessionKey: string, eventId: string): boolean {
    this.maybePruneExpiredSessions();
    const session = this.data.sessions[sessionKey];
    if (!session) {
      return false;
    }
    return session.processedEventIds.includes(eventId);
  }

  markEventProcessed(sessionKey: string, eventId: string): void {
    this.maybePruneExpiredSessions();
    const session = this.ensureSession(sessionKey);
    if (session.processedEventIds.includes(eventId)) {
      return;
    }
    session.processedEventIds.push(eventId);
    if (session.processedEventIds.length > this.maxProcessedEventsPerSession) {
      const offset = session.processedEventIds.length - this.maxProcessedEventsPerSession;
      session.processedEventIds = session.processedEventIds.slice(offset);
    }
    session.updatedAt = new Date().toISOString();
    this.schedulePersist();
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
        activeUntil: null,
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
      normalizeState(parsed);
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
    if (this.pruneSessions(now)) {
      this.schedulePersist();
    }
  }

  private pruneSessions(now = Date.now()): boolean {
    let changed = false;
    if (this.pruneExpiredSessions(now)) {
      changed = true;
    }
    if (this.pruneExcessSessions()) {
      changed = true;
    }
    return changed;
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

  private pruneExcessSessions(): boolean {
    if (this.maxSessions <= 0) {
      return false;
    }

    const sessionEntries = Object.entries(this.data.sessions);
    if (sessionEntries.length <= this.maxSessions) {
      return false;
    }

    sessionEntries.sort((left, right) => {
      const leftUpdatedAt = parseUpdatedAt(left[1].updatedAt);
      const rightUpdatedAt = parseUpdatedAt(right[1].updatedAt);
      return leftUpdatedAt - rightUpdatedAt;
    });

    const removeCount = sessionEntries.length - this.maxSessions;
    for (let i = 0; i < removeCount; i += 1) {
      delete this.data.sessions[sessionEntries[i][0]];
    }
    return true;
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

function parseUpdatedAt(updatedAt: string): number {
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeState(state: StateData): void {
  for (const session of Object.values(state.sessions)) {
    if (!Array.isArray(session.processedEventIds)) {
      session.processedEventIds = [];
    }
    if (typeof session.codexSessionId !== "string" && session.codexSessionId !== null) {
      session.codexSessionId = null;
    }
    if (typeof session.updatedAt !== "string") {
      session.updatedAt = new Date().toISOString();
    }
    if (typeof session.activeUntil !== "string" && session.activeUntil !== null) {
      session.activeUntil = null;
    }
  }
}
