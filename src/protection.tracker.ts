import { createHash, createHmac } from "crypto";
import { prisma } from "../../../../packages/database/src";
import { withKey } from "../utils/keyedLock";

// DB-backed sliding-window trackers. One row per (scopeKey, kind) holding a JSON
// array of timestamps (and, for messages, a parallel array of fingerprints).
// This keeps the table tiny — one row per active user/guild, not one per message
// — and survives bot restarts. The arrays are pruned to the window on every write.
//
// The fingerprint matters. Duplicate detection asks one question: is this the
// same message as one of the last few? That is an equality test, and a one-way
// hash answers it exactly as well as the text does. Storing the text instead
// would put readable message content in the database for the length of the
// window — which is the one thing this product promises never to do.

const MESSAGE = "MESSAGE";
const JOIN = "JOIN";

function toNumberArray(v: unknown): number[] {
  return Array.isArray(v) ? (v.filter((n) => typeof n === "number") as number[]) : [];
}
function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? (v.map((s) => String(s)) as string[]) : [];
}

// Truncated HMAC-SHA256, keyed with a server-side secret.
//
// This was a plain SHA-256, with a comment claiming it was "not stable across
// processes in any way that would let it be used as an identifier". That was
// simply wrong: SHA-256 is deterministic everywhere, for ever. Anybody holding
// the database could hash the obvious messages — "gm", "hello", a known scam
// link — and read off who had sent them. Not the message content itself, but a
// good deal more than "we store nothing readable" implies.
//
// A keyed hash answers the same equality question and makes that impossible
// without the key. The key is derived from TOKEN_ENCRYPTION_KEY rather than
// added as a new variable: it is already required in production and already
// checked to be 64 hex characters at startup, and a separate label keeps this
// use from mixing with the token encryption it was issued for.
//
// Rotating it costs nothing here. These live for seconds, so at worst one window
// stops matching itself and the next message starts a fresh one.
const FINGERPRINT_KEY = createHash("sha256")
  .update(`artsoul:spam-fingerprint:v1:${process.env.TOKEN_ENCRYPTION_KEY ?? ""}`)
  .digest();

// Truncated to 128 bits: the comparison is between a handful of messages inside
// a few seconds, so full width buys nothing and a shorter value keeps the JSON
// column small.
function fingerprint(content: string): string {
  return createHmac("sha256", FINGERPRINT_KEY).update(content).digest("hex").slice(0, 32);
}

// Record a message in the user's window and return the current window stats.
// count = messages within window; dupCount = identical-content messages within window.
// KEYED BY GUILD AND PERSON, not the person alone.
//
// This took only `discordId`, so one row held every server the same account
// posts on: someone active on their own server pushed the spam and duplicate
// counters of every other server they are in, and could be timed out on one for
// what they said on another. Everything else in the calling handler — the
// whitelist lookup, the contribution counter — was already per-guild, which is
// what makes this an oversight rather than a decision.
//
// A composite scopeKey rather than new columns: JOIN already keys on a plain
// guild id in the same field, Discord ids contain no colon, and the two kinds
// cannot collide because `kind` differs. Old rows keyed on a bare id expire on
// their own within the window, so nothing needs migrating.
//
// Serialized per key, because this reads, computes and writes back: two messages
// arriving together both read the same array and one is lost — undercounting a
// burst, which is precisely when the count is the thing being asked for.
export async function recordMessageWindow(
  guildId: string,
  discordId: string,
  content: string,
  windowMs: number
): Promise<{ count: number; dupCount: number }> {
  const scopeKey = `${guildId}:${discordId}`;
  return withKey(`msg:${scopeKey}`, () => recordMessageWindowLocked(scopeKey, content, windowMs));
}

async function recordMessageWindowLocked(
  scopeKey: string,
  content: string,
  windowMs: number
): Promise<{ count: number; dupCount: number }> {
  const now = Date.now();
  const existing = await prisma.protectionTracker.findUnique({
    where: { scopeKey_kind: { scopeKey, kind: MESSAGE } },
  });

  const hash = fingerprint(content);
  let timestamps = toNumberArray(existing?.timestamps);
  let contentHashes = toStringArray(existing?.contentHashes);

  // Prune anything outside the window (keep indices in lockstep).
  const kept: { t: number; h: string }[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (now - timestamps[i] <= windowMs) kept.push({ t: timestamps[i], h: contentHashes[i] ?? "" });
  }
  kept.push({ t: now, h: hash });

  timestamps = kept.map((k) => k.t);
  contentHashes = kept.map((k) => k.h);

  const count = timestamps.length;
  const dupCount = contentHashes.filter((h) => h === hash).length;
  const expiresAt = new Date(now + windowMs);

  await prisma.protectionTracker.upsert({
    where: { scopeKey_kind: { scopeKey, kind: MESSAGE } },
    update: { timestamps, contentHashes, expiresAt },
    create: { scopeKey, kind: MESSAGE, timestamps, contentHashes, expiresAt },
  });

  return { count, dupCount };
}

// Record a guild join in the raid window and return the join count within it.
export async function recordJoinWindow(
  guildId: string,
  windowMs: number
): Promise<{ joinCount: number }> {
  // Already correctly keyed per guild. Serialized for the same reason as
  // messages: a raid is many joins at once, which is exactly when a lost write
  // undercounts the thing being detected.
  return withKey(`join:${guildId}`, () => recordJoinWindowLocked(guildId, windowMs));
}

async function recordJoinWindowLocked(
  guildId: string,
  windowMs: number
): Promise<{ joinCount: number }> {
  const now = Date.now();
  const existing = await prisma.protectionTracker.findUnique({
    where: { scopeKey_kind: { scopeKey: guildId, kind: JOIN } },
  });

  let timestamps = toNumberArray(existing?.timestamps);
  timestamps = timestamps.filter((t) => now - t <= windowMs);
  timestamps.push(now);

  const expiresAt = new Date(now + windowMs);

  await prisma.protectionTracker.upsert({
    where: { scopeKey_kind: { scopeKey: guildId, kind: JOIN } },
    update: { timestamps, expiresAt },
    create: { scopeKey: guildId, kind: JOIN, timestamps, expiresAt },
  });

  return { joinCount: timestamps.length };
}

// Drop stale tracker rows so the table stays bounded. Returns rows removed.
export async function cleanupExpiredTrackers(): Promise<number> {
  const res = await prisma.protectionTracker.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return res.count;
}
