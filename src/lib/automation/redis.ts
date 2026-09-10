/**
 * Minimal Redis transport for the automation queue (server-only).
 *
 * The automation job ROW is the source of truth (retry-safe, idempotent);
 * Redis carries only a wake-up signal (`RPUSH lf:automation:queue <jobId>`)
 * so a worker can react promptly instead of polling. Every Redis call is
 * best-effort with a short timeout — failures resolve to null/false and
 * the DB drain path covers the work, so automation keeps running when
 * Redis is down.
 *
 * Implemented over node:net with just enough RESP2 to run
 * PING / RPUSH / LPOP / BRPOP / DEL. No client dependency.
 */

import net from "node:net";
import { env } from "../env";
import { encodeRespCommand, parseResp, type RespReply } from "./resp";

export const AUTOMATION_QUEUE_KEY = "lf:automation:queue";

export { encodeRespCommand };
export type { RespReply };

function redisEndpoint(): { host: string; port: number } {
  try {
    const url = new URL(env.redisUrl);
    return { host: url.hostname || "127.0.0.1", port: Number(url.port || 6379) };
  } catch {
    return { host: "127.0.0.1", port: 6379 };
  }
}

async function runCommand(args: Array<string | number>, timeoutMs = 2000): Promise<RespReply | null> {
  const { host, port } = redisEndpoint();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs);
    let acc = Buffer.alloc(0);
    let settled = false;
    const done = (v: RespReply | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    socket.on("error", () => done(null));
    socket.on("data", (chunk: Buffer) => {
      acc = Buffer.concat([acc, chunk]);
      try {
        const parsed = parseResp(acc);
        if (parsed) done(parsed.reply);
      } catch {
        done(null);
      }
    });
    socket.on("connect", () => {
      socket.write(encodeRespCommand(args));
    });
    socket.on("timeout", () => done(null));
  });
}

/** Best-effort liveness probe (used by health logging, never throws). */
export async function redisPing(): Promise<boolean> {
  const reply = await runCommand(["PING"]).catch(() => null);
  return reply === "PONG";
}

/** Best-effort wake-up push. Returns false when Redis is unreachable. */
export async function pushQueueSignal(jobId: string): Promise<boolean> {
  const reply = await runCommand(["RPUSH", AUTOMATION_QUEUE_KEY, jobId]).catch(() => null);
  return typeof reply === "number" && reply >= 0;
}

/** Best-effort non-blocking pop of one signal. Null when empty/down. */
export async function popQueueSignal(): Promise<string | null> {
  const reply = await runCommand(["LPOP", AUTOMATION_QUEUE_KEY]).catch(() => null);
  return typeof reply === "string" ? reply : null;
}

/**
 * Blocking pop for the worker script (timeout in seconds, 0 = forever —
 * capped here at 30s so the loop can sweep NO_CONTACT on schedule).
 * Null on timeout or when Redis is down.
 */
export async function blockingPopQueueSignal(timeoutSeconds = 30): Promise<string | null> {
  const capped = Math.min(Math.max(timeoutSeconds, 1), 30);
  const reply = await runCommand(["BRPOP", AUTOMATION_QUEUE_KEY, String(capped)], (capped + 5) * 1000).catch(
    () => null
  );
  if (Array.isArray(reply) && reply.length === 2 && typeof reply[1] === "string") return reply[1];
  return null;
}
