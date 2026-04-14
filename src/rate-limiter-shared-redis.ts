import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

import type { RateLimitReason, RateLimiterOptions, SharedRateLimiterBackend, SharedRateLimiterOptions } from "./rate-limiter";

type RedisReply = string | number | null | RedisReply[] | RedisCommandErrorReply;

interface RedisConnectionConfig {
  host: string;
  port: number;
  tls: boolean;
  username: string | null;
  password: string | null;
  database: number;
  commandTimeoutMs: number;
}

const REDIS_ACQUIRE_SCRIPT = `
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_req_user = tonumber(ARGV[3])
local max_req_room = tonumber(ARGV[4])
local max_conc_global = tonumber(ARGV[5])
local max_conc_user = tonumber(ARGV[6])
local max_conc_room = tonumber(ARGV[7])
local ttl_ms = tonumber(ARGV[8])
local member = ARGV[9]

local user_req_key = KEYS[1]
local room_req_key = KEYS[2]
local global_conc_key = KEYS[3]
local user_conc_key = KEYS[4]
local room_conc_key = KEYS[5]

local prune_before = now - window_ms

if max_req_user > 0 then
  redis.call("ZREMRANGEBYSCORE", user_req_key, "-inf", prune_before)
  local user_count = tonumber(redis.call("ZCARD", user_req_key))
  if user_count >= max_req_user then
    local oldest = redis.call("ZRANGE", user_req_key, 0, 0, "WITHSCORES")
    local retry_after = window_ms
    if oldest[2] ~= nil then
      retry_after = math.max(0, math.floor(tonumber(oldest[2]) + window_ms - now))
    end
    return {"deny", "user_requests_per_window", tostring(retry_after)}
  end
end

if max_req_room > 0 then
  redis.call("ZREMRANGEBYSCORE", room_req_key, "-inf", prune_before)
  local room_count = tonumber(redis.call("ZCARD", room_req_key))
  if room_count >= max_req_room then
    local oldest = redis.call("ZRANGE", room_req_key, 0, 0, "WITHSCORES")
    local retry_after = window_ms
    if oldest[2] ~= nil then
      retry_after = math.max(0, math.floor(tonumber(oldest[2]) + window_ms - now))
    end
    return {"deny", "room_requests_per_window", tostring(retry_after)}
  end
end

local global_conc = tonumber(redis.call("GET", global_conc_key) or "0")
if max_conc_global > 0 and global_conc >= max_conc_global then
  return {"deny", "global_concurrency", ""}
end

local user_conc = tonumber(redis.call("GET", user_conc_key) or "0")
if max_conc_user > 0 and user_conc >= max_conc_user then
  return {"deny", "user_concurrency", ""}
end

local room_conc = tonumber(redis.call("GET", room_conc_key) or "0")
if max_conc_room > 0 and room_conc >= max_conc_room then
  return {"deny", "room_concurrency", ""}
end

if max_req_user > 0 then
  redis.call("ZADD", user_req_key, now, member)
  redis.call("PEXPIRE", user_req_key, math.max(window_ms * 2, ttl_ms))
end
if max_req_room > 0 then
  redis.call("ZADD", room_req_key, now, member)
  redis.call("PEXPIRE", room_req_key, math.max(window_ms * 2, ttl_ms))
end

redis.call("INCR", global_conc_key)
redis.call("PEXPIRE", global_conc_key, ttl_ms)
redis.call("INCR", user_conc_key)
redis.call("PEXPIRE", user_conc_key, ttl_ms)
redis.call("INCR", room_conc_key)
redis.call("PEXPIRE", room_conc_key, ttl_ms)

return {"allow"}
`;

const REDIS_RELEASE_SCRIPT = `
local ttl_ms = tonumber(ARGV[1])

local function decrement(key)
  local current = tonumber(redis.call("GET", key) or "0")
  if current <= 1 then
    redis.call("DEL", key)
    return 0
  end
  local next_value = tonumber(redis.call("DECR", key))
  if ttl_ms > 0 then
    redis.call("PEXPIRE", key, ttl_ms)
  end
  return next_value
end

decrement(KEYS[1])
decrement(KEYS[2])
decrement(KEYS[3])
return {"ok"}
`;

export function createRedisSharedRateLimiterBackend(options: SharedRateLimiterOptions): SharedRateLimiterBackend | null {
  if (options.mode !== "redis" || !options.redisUrl) {
    return null;
  }
  return new RedisSharedRateLimiterBackend(options);
}

class RedisSharedRateLimiterBackend implements SharedRateLimiterBackend {
  private readonly client: RedisRespClient;
  private readonly keyPrefix: string;
  private readonly concurrencyTtlMs: number;

  constructor(options: SharedRateLimiterOptions) {
    if (!options.redisUrl) {
      throw new Error("Shared rate limiter redisUrl is required when mode=redis.");
    }
    this.client = new RedisRespClient(parseRedisConnectionConfig(options.redisUrl, options.redisCommandTimeoutMs));
    this.keyPrefix = options.redisKeyPrefix.trim() || "codeharbor:rate-limit:v1";
    this.concurrencyTtlMs = Math.max(1, Math.floor(options.redisConcurrencyTtlMs));
  }

  async tryAcquire(input: {
    params: { userId: string; roomId: string };
    now: number;
    options: RateLimiterOptions;
  }): Promise<{ allowed: boolean; reason?: RateLimitReason; retryAfterMs?: number }> {
    const keys = buildRedisRateLimiterKeys(this.keyPrefix, input.params.userId, input.params.roomId);
    const now = Math.max(0, Math.floor(input.now));
    const windowMs = Math.max(1, Math.floor(input.options.windowMs));
    const ttlMs = Math.max(windowMs * 2, this.concurrencyTtlMs);
    const reply = await this.client.sendCommand([
      "EVAL",
      REDIS_ACQUIRE_SCRIPT,
      "5",
      keys.userRequests,
      keys.roomRequests,
      keys.globalConcurrency,
      keys.userConcurrency,
      keys.roomConcurrency,
      String(now),
      String(windowMs),
      String(Math.max(0, Math.floor(input.options.maxRequestsPerUser))),
      String(Math.max(0, Math.floor(input.options.maxRequestsPerRoom))),
      String(Math.max(0, Math.floor(input.options.maxConcurrentGlobal))),
      String(Math.max(0, Math.floor(input.options.maxConcurrentPerUser))),
      String(Math.max(0, Math.floor(input.options.maxConcurrentPerRoom))),
      String(ttlMs),
      `${now}:${randomUUID()}`,
    ]);
    return parseAcquireReply(reply);
  }

  async release(input: { params: { userId: string; roomId: string } }): Promise<void> {
    const keys = buildRedisRateLimiterKeys(this.keyPrefix, input.params.userId, input.params.roomId);
    await this.client.sendCommand([
      "EVAL",
      REDIS_RELEASE_SCRIPT,
      "3",
      keys.globalConcurrency,
      keys.userConcurrency,
      keys.roomConcurrency,
      String(this.concurrencyTtlMs),
    ]);
  }
}

class RedisCommandErrorReply extends Error {}

class RedisRespClient {
  private readonly config: RedisConnectionConfig;

  constructor(config: RedisConnectionConfig) {
    this.config = config;
  }

  async sendCommand(command: string[]): Promise<RedisReply> {
    const startupCommands: string[][] = [];
    if (this.config.password) {
      if (this.config.username) {
        startupCommands.push(["AUTH", this.config.username, this.config.password]);
      } else {
        startupCommands.push(["AUTH", this.config.password]);
      }
    }
    if (this.config.database > 0) {
      startupCommands.push(["SELECT", String(this.config.database)]);
    }
    const replies = await this.runCommands([...startupCommands, command]);
    return replies[replies.length - 1] ?? null;
  }

  private async runCommands(commands: string[][]): Promise<RedisReply[]> {
    return new Promise<RedisReply[]>((resolve, reject) => {
      const socket: net.Socket | tls.TLSSocket = this.config.tls
        ? tls.connect({
            host: this.config.host,
            port: this.config.port,
            servername: this.config.host,
          })
        : net.createConnection({
            host: this.config.host,
            port: this.config.port,
          });

      const payload = commands.map((command) => serializeRedisCommand(command)).join("");
      const replies: RedisReply[] = [];
      let buffer = Buffer.alloc(0);
      let settled = false;

      const finish = (handler: "resolve" | "reject", value: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.removeAllListeners();
        socket.destroy();
        if (handler === "resolve") {
          resolve(value as RedisReply[]);
        } else {
          reject(value);
        }
      };

      const timeout = setTimeout(() => {
        finish("reject", new Error("Redis command timeout."));
      }, this.config.commandTimeoutMs);
      timeout.unref?.();

      socket.once("error", (error) => {
        finish("reject", error);
      });
      socket.once("connect", () => {
        socket.write(payload);
      });
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const parsed = parseRedisReply(buffer, 0);
          if (!parsed) {
            break;
          }
          buffer = buffer.subarray(parsed.nextOffset);
          if (parsed.reply instanceof RedisCommandErrorReply) {
            finish("reject", parsed.reply);
            return;
          }
          replies.push(parsed.reply);
          if (replies.length >= commands.length) {
            finish("resolve", replies);
            return;
          }
        }
      });
      socket.once("close", () => {
        if (!settled) {
          finish("reject", new Error("Redis connection closed before command completed."));
        }
      });
    });
  }
}

function parseAcquireReply(reply: RedisReply): { allowed: boolean; reason?: RateLimitReason; retryAfterMs?: number } {
  if (!Array.isArray(reply) || reply.length === 0) {
    throw new Error("Invalid redis acquire response.");
  }
  const kind = asStringReply(reply[0]);
  if (kind === "allow") {
    return { allowed: true };
  }
  if (kind === "deny") {
    const reason = asRateLimitReason(reply[1]);
    const retryAfterMs = parseRetryAfterMs(reply[2]);
    return {
      allowed: false,
      reason,
      retryAfterMs: retryAfterMs ?? undefined,
    };
  }
  throw new Error(`Unsupported redis acquire response kind: ${kind}`);
}

function parseRetryAfterMs(value: RedisReply | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return null;
    }
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function asRateLimitReason(value: RedisReply | undefined): RateLimitReason {
  const normalized = asStringReply(value ?? "").trim();
  if (
    normalized === "user_requests_per_window" ||
    normalized === "room_requests_per_window" ||
    normalized === "global_concurrency" ||
    normalized === "user_concurrency" ||
    normalized === "room_concurrency"
  ) {
    return normalized;
  }
  return "global_concurrency";
}

function asStringReply(value: RedisReply): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (value === null) {
    return "";
  }
  throw new Error("Unexpected redis reply value.");
}

function buildRedisRateLimiterKeys(
  prefix: string,
  userId: string,
  roomId: string,
): {
  userRequests: string;
  roomRequests: string;
  globalConcurrency: string;
  userConcurrency: string;
  roomConcurrency: string;
} {
  const userKey = hashIdentity(userId);
  const roomKey = hashIdentity(roomId);
  return {
    userRequests: `${prefix}:req:user:${userKey}`,
    roomRequests: `${prefix}:req:room:${roomKey}`,
    globalConcurrency: `${prefix}:conc:global`,
    userConcurrency: `${prefix}:conc:user:${userKey}`,
    roomConcurrency: `${prefix}:conc:room:${roomKey}`,
  };
}

function hashIdentity(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function parseRedisConnectionConfig(rawUrl: string, commandTimeoutMs: number): RedisConnectionConfig {
  const parsed = new URL(rawUrl);
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "redis:" && protocol !== "rediss:") {
    throw new Error("RATE_LIMIT_SHARED_REDIS_URL must use redis:// or rediss:// scheme.");
  }
  if (!parsed.hostname) {
    throw new Error("RATE_LIMIT_SHARED_REDIS_URL host is required.");
  }
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 6379;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error("RATE_LIMIT_SHARED_REDIS_URL port is invalid.");
  }
  const databaseRaw = parsed.pathname.replace(/^\//, "").trim();
  const database = databaseRaw ? Number.parseInt(databaseRaw, 10) : 0;
  if (!Number.isInteger(database) || database < 0) {
    throw new Error("RATE_LIMIT_SHARED_REDIS_URL database index is invalid.");
  }
  const username = parsed.username ? decodeURIComponent(parsed.username) : null;
  const password = parsed.password ? decodeURIComponent(parsed.password) : null;
  return {
    host: parsed.hostname,
    port,
    tls: protocol === "rediss:",
    username,
    password,
    database,
    commandTimeoutMs: Math.max(50, Math.floor(commandTimeoutMs)),
  };
}

function serializeRedisCommand(command: readonly string[]): string {
  let payload = `*${command.length}\r\n`;
  for (const argument of command) {
    const value = String(argument);
    payload += `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  }
  return payload;
}

function parseRedisReply(buffer: Buffer, offset: number): { reply: RedisReply; nextOffset: number } | null {
  if (offset >= buffer.length) {
    return null;
  }
  const prefix = String.fromCharCode(buffer[offset]);
  if (prefix === "+" || prefix === "-" || prefix === ":") {
    const lineEnd = indexOfCrlf(buffer, offset + 1);
    if (lineEnd < 0) {
      return null;
    }
    const line = buffer.subarray(offset + 1, lineEnd).toString("utf8");
    if (prefix === "+") {
      return {
        reply: line,
        nextOffset: lineEnd + 2,
      };
    }
    if (prefix === "-") {
      return {
        reply: new RedisCommandErrorReply(line),
        nextOffset: lineEnd + 2,
      };
    }
    const value = Number.parseInt(line, 10);
    if (!Number.isFinite(value)) {
      throw new Error("Invalid redis integer response.");
    }
    return {
      reply: value,
      nextOffset: lineEnd + 2,
    };
  }

  if (prefix === "$") {
    const lineEnd = indexOfCrlf(buffer, offset + 1);
    if (lineEnd < 0) {
      return null;
    }
    const lengthRaw = buffer.subarray(offset + 1, lineEnd).toString("utf8");
    const length = Number.parseInt(lengthRaw, 10);
    if (!Number.isInteger(length)) {
      throw new Error("Invalid redis bulk length.");
    }
    if (length === -1) {
      return {
        reply: null,
        nextOffset: lineEnd + 2,
      };
    }
    const bodyStart = lineEnd + 2;
    const bodyEnd = bodyStart + length;
    if (bodyEnd + 2 > buffer.length) {
      return null;
    }
    if (buffer[bodyEnd] !== 13 || buffer[bodyEnd + 1] !== 10) {
      throw new Error("Invalid redis bulk terminator.");
    }
    return {
      reply: buffer.subarray(bodyStart, bodyEnd).toString("utf8"),
      nextOffset: bodyEnd + 2,
    };
  }

  if (prefix === "*") {
    const lineEnd = indexOfCrlf(buffer, offset + 1);
    if (lineEnd < 0) {
      return null;
    }
    const lengthRaw = buffer.subarray(offset + 1, lineEnd).toString("utf8");
    const length = Number.parseInt(lengthRaw, 10);
    if (!Number.isInteger(length)) {
      throw new Error("Invalid redis array length.");
    }
    if (length === -1) {
      return {
        reply: null,
        nextOffset: lineEnd + 2,
      };
    }
    let nextOffset = lineEnd + 2;
    const entries: RedisReply[] = [];
    for (let index = 0; index < length; index += 1) {
      const parsedEntry = parseRedisReply(buffer, nextOffset);
      if (!parsedEntry) {
        return null;
      }
      entries.push(parsedEntry.reply);
      nextOffset = parsedEntry.nextOffset;
    }
    return {
      reply: entries,
      nextOffset,
    };
  }

  throw new Error(`Unsupported redis reply prefix: ${prefix}`);
}

function indexOfCrlf(buffer: Buffer, startIndex: number): number {
  for (let index = startIndex; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10) {
      return index;
    }
  }
  return -1;
}
