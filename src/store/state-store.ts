import fs from "node:fs";
import path from "node:path";

import { SessionState, StateData } from "../types";

const EMPTY_STATE: StateData = { sessions: {} };

export class StateStore {
  private readonly filePath: string;
  private readonly maxProcessedEventsPerSession: number;
  private data: StateData;

  constructor(filePath: string, maxProcessedEventsPerSession: number) {
    this.filePath = filePath;
    this.maxProcessedEventsPerSession = maxProcessedEventsPerSession;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.data = this.load();
  }

  getCodexSessionId(sessionKey: string): string | null {
    return this.ensureSession(sessionKey).codexSessionId;
  }

  setCodexSessionId(sessionKey: string, codexSessionId: string): void {
    const session = this.ensureSession(sessionKey);
    session.codexSessionId = codexSessionId;
    session.updatedAt = new Date().toISOString();
    this.persist();
  }

  markEventIfNew(sessionKey: string, eventId: string): boolean {
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
    this.persist();
    return true;
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

  private persist(): void {
    this.writeFile(this.data);
  }

  private writeFile(data: StateData): void {
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, this.filePath);
  }
}
