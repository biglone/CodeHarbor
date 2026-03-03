import fs from "node:fs";
import path from "node:path";

export interface CliCompatRecordEntry {
  timestamp: string;
  requestId: string;
  sessionKey: string;
  conversationId: string;
  senderId: string;
  prompt: string;
  imageCount: number;
}

export class CliCompatRecorder {
  private readonly filePath: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  append(entry: CliCompatRecordEntry): Promise<void> {
    const payload = `${JSON.stringify(entry)}\n`;
    this.chain = this.chain.then(async () => {
      await fs.promises.appendFile(this.filePath, payload, "utf8");
    });
    return this.chain;
  }
}
