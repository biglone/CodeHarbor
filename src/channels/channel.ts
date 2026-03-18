import { InboundMessage } from "../types";

export type InboundHandler = (message: InboundMessage) => Promise<void>;

export interface Channel {
  start(handler: InboundHandler): Promise<void>;
  sendMessage(conversationId: string, text: string): Promise<void>;
  sendNotice(conversationId: string, text: string): Promise<void>;
  upsertProgressNotice(conversationId: string, text: string, replaceEventId: string | null): Promise<string>;
  setTyping(conversationId: string, isTyping: boolean, timeoutMs: number): Promise<void>;
  stop(): Promise<void>;
}
