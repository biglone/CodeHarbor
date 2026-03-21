import { InboundMessage } from "../types";

export type InboundHandler = (message: InboundMessage) => Promise<void>;

export interface OutboundMultimodalImageSummary {
  total: number;
  included: number;
  names: string[];
}

export interface OutboundMultimodalAudioSummaryItem {
  name: string;
  summary: string;
}

export interface OutboundMultimodalAudioSummary {
  total: number;
  transcribed: number;
  items: OutboundMultimodalAudioSummaryItem[];
}

export interface OutboundMultimodalSummary {
  images: OutboundMultimodalImageSummary | null;
  audio: OutboundMultimodalAudioSummary | null;
}

export interface SendMessageOptions {
  multimodalSummary?: OutboundMultimodalSummary | null;
}

export interface Channel {
  start(handler: InboundHandler): Promise<void>;
  sendMessage(conversationId: string, text: string, options?: SendMessageOptions): Promise<void>;
  sendNotice(conversationId: string, text: string): Promise<void>;
  upsertProgressNotice(conversationId: string, text: string, replaceEventId: string | null): Promise<string>;
  setTyping(conversationId: string, isTyping: boolean, timeoutMs: number): Promise<void>;
  stop(): Promise<void>;
}
