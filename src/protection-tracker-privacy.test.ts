import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../packages/database/src", () => ({
  prisma: {
    protectionTracker: {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn(),
    },
  },
}));

import { prisma } from "../../../../packages/database/src";
import { recordMessageWindow } from "../protection/protection.tracker";

const p = prisma as any;
beforeEach(() => vi.clearAllMocks());

// The duplicate-spam detector used to write the message text into the database
// for the length of its window, which quietly made "message content is never
// stored" untrue — a claim the product makes on its trust page and in its
// marketing. Equality is all the detector ever needed, so it hashes instead.
//
// These tests exist to keep that true. The first one is the promise itself; the
// second makes sure keeping it did not cost the feature.
describe("the spam tracker never writes message text down", () => {
  const SECRET = "my bank password is hunter2 and my address is 12 Elm Street";

  it("persists no fragment of the message", async () => {
    p.protectionTracker.findUnique.mockResolvedValue(null);
    await recordMessageWindow("100000000000000001", SECRET, 10_000);

    const written = JSON.stringify(p.protectionTracker.upsert.mock.calls[0][0]);
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain("hunter2");
    expect(written).not.toContain("Elm Street");
    // Nor any run of the original long enough to be recognisable.
    for (let i = 0; i + 12 <= SECRET.length; i += 4) {
      expect(written).not.toContain(SECRET.slice(i, i + 12));
    }
  });

  it("still counts a repeat as a duplicate", async () => {
    p.protectionTracker.findUnique.mockResolvedValue(null);
    const first = await recordMessageWindow("100000000000000001", "buy followers now", 10_000);
    expect(first.dupCount).toBe(1);

    // Feed the first write back in as the stored row, the way the database would.
    const stored = p.protectionTracker.upsert.mock.calls[0][0].create;
    p.protectionTracker.findUnique.mockResolvedValue(stored);

    const second = await recordMessageWindow("100000000000000001", "buy followers now", 10_000);
    expect(second.dupCount).toBe(2);
    expect(second.count).toBe(2);
  });

  it("does not treat a different message as a duplicate", async () => {
    p.protectionTracker.findUnique.mockResolvedValue(null);
    await recordMessageWindow("100000000000000001", "hello", 10_000);
    const stored = p.protectionTracker.upsert.mock.calls[0][0].create;
    p.protectionTracker.findUnique.mockResolvedValue(stored);

    const other = await recordMessageWindow("100000000000000001", "goodbye", 10_000);
    expect(other.dupCount).toBe(1);
    expect(other.count).toBe(2);
  });
});
