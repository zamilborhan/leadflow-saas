/**
 * Minimal RESP2 codec for the automation Redis transport. Pure module (no
 * imports) so unit tests exercise it directly via Node type-stripping.
 * Supports the reply shapes the queue uses: simple strings, errors,
 * integers, bulk strings, and arrays (BRPOP's two-element reply).
 */

export type RespReply = string | number | null | RespReply[];

/** Pure RESP2 encoder. */
export function encodeRespCommand(args: Array<string | number>): string {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const s = String(arg);
    const bytes = Buffer.byteLength(s, "utf8");
    out += `$${bytes}\r\n${s}\r\n`;
  }
  return out;
}

/** Parse one reply from the front of the buffer; null when incomplete. */
export function parseResp(buffer: Buffer): { reply: RespReply; rest: Buffer } | null {
  if (buffer.length === 0) return null;
  const type = String.fromCharCode(buffer[0]);
  const lineEnd = buffer.indexOf("\r\n");
  if (lineEnd === -1) return null;
  const line = buffer.subarray(1, lineEnd).toString("utf8");
  if (type === "+" || type === "-") return { reply: line, rest: buffer.subarray(lineEnd + 2) };
  if (type === ":") return { reply: Number.parseInt(line, 10), rest: buffer.subarray(lineEnd + 2) };
  if (type === "$") {
    const len = Number.parseInt(line, 10);
    if (len === -1) return { reply: null, rest: buffer.subarray(lineEnd + 2) };
    const start = lineEnd + 2;
    if (buffer.length < start + len + 2) return null;
    return { reply: buffer.subarray(start, start + len).toString("utf8"), rest: buffer.subarray(start + len + 2) };
  }
  if (type === "*") {
    const count = Number.parseInt(line, 10);
    if (count === -1) return { reply: null, rest: buffer.subarray(lineEnd + 2) };
    let rest = buffer.subarray(lineEnd + 2);
    const items: RespReply[] = [];
    for (let i = 0; i < count; i++) {
      const parsed = parseResp(rest);
      if (!parsed) return null;
      items.push(parsed.reply);
      rest = parsed.rest;
    }
    return { reply: items, rest };
  }
  return { reply: line, rest: buffer.subarray(lineEnd + 2) };
}
