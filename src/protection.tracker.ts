import { createHash } from "crypto";
import { prisma } from "../../../../packages/database/src";

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

// Truncated SHA-256. Full width buys nothing here: the comparison is between a
// handful of messages inside a few seconds, and a shorter value keeps the JSON
// column small. Not reversible, and not stable across processes in any way that
// would let it be used as an identifier.
function fingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

// Record a message in the user's window and return the current window stats.
// count = messages within window; dupCount = identical-content messages within window.
export async function recordMessageWindow(
  discordId: string,
  content: string,
  windowMs: number
): Promise<{ count: number; dupCount: number }> {
  const now = Date.now();
  const existing = await prisma.protectionTracker.findUnique({
    where: { scopeKey_kind: { scopeKey: discordId, kind: MESSAGE } },
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
    where: { scopeKey_kind: { scopeKey: discordId, kind: MESSAGE } },
    update: { timestamps, contentHashes, expiresAt },
    create: { scopeKey: discordId, kind: MESSAGE, timestamps, contentHashes, expiresAt },
  });

  return { count, dupCount };
}

// Record a guild join in the raid window and return the join count within it.
export async function recordJoinWindow(
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
