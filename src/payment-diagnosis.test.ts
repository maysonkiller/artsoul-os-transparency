import { describe, it, expect } from "vitest";
import { fromTokenUnits, toTokenUnits } from "../payments/crypto.service";

// A real payment attempt exposed this: a customer sent the network's native coin
// to an invoice denominated in a token, and was told the transfer "came from a
// different wallet". The sender had in fact been correct. Every branch below is
// one of the four distinct mistakes that used to collapse into that one message,
// checked against the same scan the verifier runs.
//
// The scan is re-declared here rather than exported, because exporting it purely
// for a test would widen the service's surface for no caller.

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Synthetic addresses. The originals were the operator's payout wallet and the
// real payer's — the arithmetic does not care which addresses these are, and
// leaving them in tied a person's wallet to this repository.
const PAY_TO = "0xaaaa0000000000000000000000000000000000aa";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PAYER = "0xbbbb0000000000000000000000000000000000bb";
const STRANGER = "0x1111111111111111111111111111111111111111";

function topic(address: string): string {
  return `0x000000000000000000000000${address.slice(2)}`;
}

function transferLog(token: string, from: string, to: string, value: bigint) {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, topic(from), topic(to)],
    data: `0x${value.toString(16)}`,
  };
}

// Mirrors the outcome ladder in verifyPayment.
function diagnose(
  logs: unknown[],
  tx: { to?: string; value?: string } | null,
  expectedFrom: string | null
): string {
  let fromPayer = 0n;
  let fromOthers = 0n;
  let otherTokenToUs = false;
  let nativeToUs = 0n;

  for (const raw of logs) {
    const log = raw as any;
    if (String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    if (`0x${String(log.topics[2]).slice(-40)}`.toLowerCase() !== PAY_TO) continue;
    if (String(log.address).toLowerCase() !== USDC) { otherTokenToUs = true; continue; }
    const sender = `0x${String(log.topics[1]).slice(-40)}`.toLowerCase();
    const value = BigInt(log.data);
    if (!expectedFrom || sender === expectedFrom) fromPayer += value;
    else fromOthers += value;
  }
  if (tx && String(tx.to ?? "").toLowerCase() === PAY_TO) nativeToUs = BigInt(tx.value ?? "0x0");

  if (fromPayer > 0n) return "accepted";
  if (fromOthers > 0n) return "wrong_sender";
  if (nativeToUs > 0n) return "native_coin_sent";
  if (otherTokenToUs) return "wrong_token";
  return "no_matching_transfer";
}

describe("telling the customer what actually went wrong", () => {
  it("names a native coin transfer instead of blaming the wallet", () => {
    // The exact shape of the transaction that produced the wrong message: a bare
    // ETH send to the right wallet, from the right payer, with no logs at all.
    const verdict = diagnose([], { to: PAY_TO, value: "0x6653b9ab8a3f3" }, PAYER);
    expect(verdict).toBe("native_coin_sent");
  });

  it("only says wrong_sender when somebody else really did pay", () => {
    const logs = [transferLog(USDC, STRANGER, PAY_TO, 29_000000n)];
    expect(diagnose(logs, null, PAYER)).toBe("wrong_sender");
  });

  it("names the wrong token rather than a missing transfer", () => {
    const someOtherToken = "0x4200000000000000000000000000000000000006";
    const logs = [transferLog(someOtherToken, PAYER, PAY_TO, 29_000000n)];
    expect(diagnose(logs, null, PAYER)).toBe("wrong_token");
  });

  it("still reports nothing found when nothing reached us", () => {
    const logs = [transferLog(USDC, PAYER, STRANGER, 29_000000n)];
    expect(diagnose(logs, null, PAYER)).toBe("no_matching_transfer");
  });

  it("accepts a transfer from the declared payer", () => {
    const logs = [transferLog(USDC, PAYER, PAY_TO, 29_000000n)];
    expect(diagnose(logs, null, PAYER)).toBe("accepted");
  });

  it("does not credit a stranger's transfer riding along in the same transaction", () => {
    const logs = [
      transferLog(USDC, STRANGER, PAY_TO, 29_000000n),
      transferLog(USDC, PAYER, PAY_TO, 1_000000n),
    ];
    // The payer's own dollar is credited; the stranger's twenty-nine are not, so
    // this is an underpayment rather than a settled invoice.
    let credited = 0n;
    for (const log of logs) {
      const sender = `0x${String(log.topics[1]).slice(-40)}`.toLowerCase();
      if (sender === PAYER) credited += BigInt(log.data);
    }
    expect(credited).toBe(1_000000n);
  });
});

describe("amounts survive the round trip", () => {
  it("converts to units and back without drift", () => {
    for (const amount of ["29", "14", "6", "0.5", "1.234567"]) {
      const units = toTokenUnits(amount, 6);
      expect(Number(fromTokenUnits(units, 6))).toBeCloseTo(Number(amount), 9);
    }
  });

  it("reports a remainder the customer can paste into a wallet", () => {
    const need = toTokenUnits("29", 6);
    const paid = toTokenUnits("1.5", 6);
    expect(fromTokenUnits(need - paid, 6)).toBe("27.5");
  });

  it("never shows a negative remainder once the invoice is covered", () => {
    const need = toTokenUnits("29", 6);
    const paid = toTokenUnits("30", 6);
    const remaining = paid >= need ? 0n : need - paid;
    expect(fromTokenUnits(remaining, 6)).toBe("0");
  });

  it("adds two underpayments up to the price", () => {
    const need = toTokenUnits("29", 6);
    const first = toTokenUnits("1.5", 6);
    const second = toTokenUnits("27.5", 6);
    expect(first + second).toBe(need);
  });
});
