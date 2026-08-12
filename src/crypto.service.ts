import axios from "axios";
import { Prisma, type CryptoPaymentConfig, type PaymentIntent } from "@prisma/client";
import { prisma } from "../../../../packages/database/src";
import { PLAN_PRICING, type PlanName } from "../../../../packages/shared/src";
import { planChangeFor } from "./planChange";

// Customers pay a stablecoin directly to the operator wallet. The submitted
// transaction hash identifies the payment; the server derives every relevant
// fact from chain data and activates a subscription atomically.

const CONFIG_ID = "default";
const INTENT_TTL_HOURS = 24;
// A native-coin invoice carries a frozen exchange rate, so its useful life is the
// length of time that rate can be trusted — not a day. A stablecoin invoice has
// no rate to go stale and keeps the longer window.
const NATIVE_INTENT_TTL_MINUTES = 60;
// latestRoundData() on a Chainlink-style aggregator. A quote older than this is
// treated as no quote at all: pricing a subscription off a feed that stopped
// updating is how an invoice ends up asking for a tenth of its worth.
const PRICE_FEED_SELECTOR = "0xfeaf968c";
const PRICE_FEED_DECIMALS_SELECTOR = "0x313ce567";
const MAX_QUOTE_AGE_SECONDS = 3600;

// ERC-20 Transfer(address,address,uint256)
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export async function getConfig(): Promise<CryptoPaymentConfig> {
  return prisma.cryptoPaymentConfig.upsert({
    where: { id: CONFIG_ID },
    update: {},
    create: { id: CONFIG_ID },
  });
}

export interface CryptoConfigInput {
  enabled?: boolean;
  payToAddress?: string | null;
  chainName?: string;
  chainId?: number;
  tokenSymbol?: string;
  tokenAddress?: string | null;
  tokenDecimals?: number;
  minConfirmations?: number;
  acceptNative?: boolean;
  nativeSymbol?: string;
  nativeDecimals?: number;
  priceFeedAddress?: string | null;
}

function configuredRpcUrl(): string | null {
  const value = process.env.CRYPTO_PAYMENT_RPC_URL?.trim();
  return value && /^https:\/\//i.test(value) ? value : null;
}

// An RPC endpoint is infrastructure, not editable product data. Keeping it in a
// server-only environment variable prevents a dashboard account from turning
// the API into an SSRF proxy.
export function validateConfig(
  c: CryptoPaymentConfig,
  rpcUrl: string | null = configuredRpcUrl()
): string | null {
  if (!c.enabled) return null;
  if (!c.payToAddress || !ADDRESS_RE.test(c.payToAddress)) return "pay_to_address_invalid";
  if (!c.tokenAddress || !ADDRESS_RE.test(c.tokenAddress)) return "token_address_invalid";
  if (!rpcUrl) return "rpc_url_invalid";
  if (c.tokenDecimals < 0 || c.tokenDecimals > 36) return "token_decimals_invalid";
  if (c.minConfirmations < 1 || c.minConfirmations > 64) return "min_confirmations_invalid";
  return null;
}

async function rpcMatchesConfiguredChain(
  config: CryptoPaymentConfig,
  rpcUrl: string | null = configuredRpcUrl()
): Promise<boolean> {
  if (!rpcUrl) return false;
  try {
    const chainIdHex = await rpc<string>(rpcUrl, "eth_chainId", []);
    return BigInt(chainIdHex) === BigInt(config.chainId);
  } catch (error) {
    console.error("[Payments] RPC chain check failed:", error);
    return false;
  }
}

export async function setConfig(input: CryptoConfigInput, updatedBy: string): Promise<CryptoPaymentConfig> {
  const data: Prisma.CryptoPaymentConfigUpdateInput = { updatedBy };
  const address = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;

  if (typeof input.enabled === "boolean") data.enabled = input.enabled;
  if (typeof input.acceptNative === "boolean") data.acceptNative = input.acceptNative;
  if (input.payToAddress !== undefined) data.payToAddress = address(input.payToAddress);
  if (input.tokenAddress !== undefined) data.tokenAddress = address(input.tokenAddress);
  if (input.priceFeedAddress !== undefined) data.priceFeedAddress = address(input.priceFeedAddress);
  if (typeof input.nativeSymbol === "string" && input.nativeSymbol.trim()) {
    data.nativeSymbol = input.nativeSymbol.trim().toUpperCase().slice(0, 12);
  }
  if (Number.isFinite(input.nativeDecimals)) {
    data.nativeDecimals = Math.min(36, Math.max(0, Math.floor(input.nativeDecimals as number)));
  }
  if (typeof input.chainName === "string" && input.chainName.trim()) {
    data.chainName = input.chainName.trim().slice(0, 40);
  }
  if (typeof input.tokenSymbol === "string" && input.tokenSymbol.trim()) {
    data.tokenSymbol = input.tokenSymbol.trim().toUpperCase().slice(0, 12);
  }
  if (Number.isFinite(input.chainId)) data.chainId = Math.max(1, Math.floor(input.chainId as number));
  if (Number.isFinite(input.tokenDecimals)) {
    data.tokenDecimals = Math.min(36, Math.max(0, Math.floor(input.tokenDecimals as number)));
  }
  if (Number.isFinite(input.minConfirmations)) {
    data.minConfirmations = Math.min(64, Math.max(1, Math.floor(input.minConfirmations as number)));
  }

  await getConfig();
  let saved = await prisma.cryptoPaymentConfig.update({ where: { id: CONFIG_ID }, data });

  // Native payments are only offered when the feed that prices them answers
  // right now. Advertising the option against a feed that turns out to be silent
  // would put customers in front of a button that fails at the last step.
  if (saved.acceptNative) {
    const rpcUrl = configuredRpcUrl();
    const quote = saved.priceFeedAddress && ADDRESS_RE.test(saved.priceFeedAddress) && rpcUrl
      ? await fetchNativeQuote(rpcUrl, saved.priceFeedAddress)
      : null;
    if (!quote) {
      saved = await prisma.cryptoPaymentConfig.update({
        where: { id: CONFIG_ID },
        data: { acceptNative: false },
      });
    }
  }

  const problem = validateConfig(saved);
  const rpcMatches = !problem && saved.enabled ? await rpcMatchesConfiguredChain(saved) : true;
  if ((problem || !rpcMatches) && saved.enabled) {
    // Preserve the entered values, but never leave an unverifiable gateway live.
    return prisma.cryptoPaymentConfig.update({ where: { id: CONFIG_ID }, data: { enabled: false } });
  }
  return saved;
}

export function basePrice(plan: PlanName, months: number): number {
  const price = PLAN_PRICING[plan];
  if (!price) return 0;
  return months === 12 ? price.yearly : price.monthly;
}

// Smallest-unit integer for on-chain comparison; floats never touch the money
// boundary.
export function toTokenUnits(amount: string, decimals: number): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(amount)) throw new Error("amount_invalid");
  const [whole, frac = ""] = amount.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

// ── Pricing the native coin ──────────────────────────────────────────────────
//
// USDC needs no rate. The native coin does, and getting it wrong is expensive in
// one direction only: an invoice that asks for too little hands out a
// subscription for a fraction of its price. So every failure here — unreachable
// feed, malformed answer, non-positive price, a quote that stopped updating —
// refuses to issue the invoice rather than guessing.

interface Quote {
  /** USD per whole native coin, scaled by 1e8 for integer arithmetic. */
  usdPerCoinE8: bigint;
  updatedAt: number;
}

function decodeInt(word: string): bigint {
  return BigInt(`0x${word}`);
}

export async function fetchNativeQuote(rpcUrl: string, feed: string): Promise<Quote | null> {
  try {
    const [roundHex, decimalsHex] = await Promise.all([
      rpc<string>(rpcUrl, "eth_call", [{ to: feed, data: PRICE_FEED_SELECTOR }, "latest"]),
      rpc<string>(rpcUrl, "eth_call", [{ to: feed, data: PRICE_FEED_DECIMALS_SELECTOR }, "latest"]),
    ]);
    const body = roundHex.replace(/^0x/, "");
    // latestRoundData() → (roundId, answer, startedAt, updatedAt, answeredInRound)
    if (body.length < 64 * 5) return null;
    const answer = decodeInt(body.slice(64, 128));
    const updatedAt = Number(decodeInt(body.slice(192, 256)));
    const decimals = Number(decodeInt(decimalsHex.replace(/^0x/, "")));
    if (answer <= 0n || !Number.isFinite(decimals) || decimals < 0 || decimals > 36) return null;
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
    if (Date.now() / 1000 - updatedAt > MAX_QUOTE_AGE_SECONDS) return null;

    // Normalise whatever the feed's precision is onto a common 1e8 scale.
    const usdPerCoinE8 =
      decimals >= 8
        ? answer / 10n ** BigInt(decimals - 8)
        : answer * 10n ** BigInt(8 - decimals);
    if (usdPerCoinE8 <= 0n) return null;
    return { usdPerCoinE8, updatedAt };
  } catch (error) {
    console.error("[Payments] price feed unavailable:", error);
    return null;
  }
}

// How much native coin settles a dollar amount, rounded UP: rounding down would
// leave every invoice a few wei short and every customer looking at a balance
// they cannot clear.
export function nativeAmountFor(usd: number, quote: Quote, decimals: number): string {
  const usdE8 = BigInt(Math.round(usd * 1e8));
  const scale = 10n ** BigInt(decimals);
  const units = (usdE8 * scale + quote.usdPerCoinE8 - 1n) / quote.usdPerCoinE8;
  // Quote to six decimal places so the customer can retype it if they must, and
  // round up again so the trimmed amount still covers the price.
  const step = decimals > 6 ? 10n ** BigInt(decimals - 6) : 1n;
  const rounded = ((units + step - 1n) / step) * step;
  return fromTokenUnits(rounded, decimals);
}

export interface CreateIntentResult {
  ok: boolean;
  reason?: string;
  intent?: PaymentIntent;
}

export type PayCurrencyName = "TOKEN" | "NATIVE";

export async function createIntent(
  guildId: string,
  plan: PlanName,
  months: number,
  createdBy: string,
  expectedFrom: string,
  currency: PayCurrencyName = "TOKEN"
): Promise<CreateIntentResult> {
  const config = await getConfig();
  if (!config.enabled) return { ok: false, reason: "payments_disabled" };
  if (validateConfig(config)) return { ok: false, reason: "payments_misconfigured" };
  if (!(await rpcMatchesConfiguredChain(config))) {
    return { ok: false, reason: "payments_misconfigured" };
  }
  if (plan === "FREE" || (months !== 1 && months !== 12)) {
    return { ok: false, reason: "plan_not_purchasable" };
  }

  const price = basePrice(plan, months);
  if (price <= 0) return { ok: false, reason: "plan_not_purchasable" };

  // Without a declared payer the invoice would settle against any matching
  // transfer, including one lifted from the public chain by someone else.
  const payer = String(expectedFrom ?? "").trim().toLowerCase();
  if (!ADDRESS_RE.test(payer)) return { ok: false, reason: "from_address_invalid" };

  const native = currency === "NATIVE";
  let amountExact = String(price);
  let quotedRate: string | null = null;

  if (native) {
    if (!config.acceptNative || !config.priceFeedAddress) {
      return { ok: false, reason: "native_not_accepted" };
    }
    const quote = await fetchNativeQuote(configuredRpcUrl()!, config.priceFeedAddress);
    // No usable quote means no invoice. Falling back to a stale or guessed rate
    // is the one failure that costs real money.
    if (!quote) return { ok: false, reason: "price_feed_unavailable" };
    amountExact = nativeAmountFor(price, quote, config.nativeDecimals);
    quotedRate = fromTokenUnits(quote.usdPerCoinE8, 8);
  }

  const intent = await prisma.paymentIntent.create({
    data: {
      guildId,
      plan: plan as never,
      months,
      amountExact,
      payCurrency: currency as never,
      usdPrice: String(price),
      quotedRate,
      tokenSymbol: native ? config.nativeSymbol : config.tokenSymbol,
      chainName: config.chainName,
      chainId: config.chainId,
      // A native invoice has no token contract; leaving it null is what marks the
      // transaction's own value as the thing being counted.
      tokenAddress: native ? null : config.tokenAddress!.toLowerCase(),
      tokenDecimals: native ? config.nativeDecimals : config.tokenDecimals,
      minConfirmations: config.minConfirmations,
      payToAddress: config.payToAddress!.toLowerCase(),
      createdBy,
      expectedFrom: payer,
      expiresAt: new Date(
        Date.now() + (native ? NATIVE_INTENT_TTL_MINUTES * 60_000 : INTENT_TTL_HOURS * 60 * 60_000)
      ),
    },
  });
  return { ok: true, intent };
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await axios.post(
    url,
    { jsonrpc: "2.0", id: 1, method, params },
    { timeout: 15_000, maxRedirects: 0 }
  );
  if (response.data?.error) throw new Error(response.data.error?.message || "rpc_error");
  if (response.data?.result === undefined) throw new Error("rpc_result_missing");
  return response.data.result as T;
}

function topicToAddress(topic: string): string {
  return (`0x${topic.slice(-40)}`).toLowerCase();
}

export function confirmationCount(headBlock: string, receiptBlock: string): bigint {
  const head = BigInt(headBlock);
  const receipt = BigInt(receiptBlock);
  if (receipt > head) throw new Error("receipt_ahead_of_chain");
  return head - receipt + 1n;
}

// Human-readable decimal from smallest units — the inverse of toTokenUnits, used
// only to tell the customer how much is still owed.
export function fromTokenUnits(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const value = negative ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export interface PaymentProgress {
  /** Total accepted so far, in display units. */
  paidExact: string;
  /** The invoice price, in display units. */
  needExact: string;
  /** What is still owed, in display units. */
  remainingExact: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  intent?: PaymentIntent;
  newlyConfirmed?: boolean;
  /** Present whenever some money has landed — on success and on underpayment. */
  progress?: PaymentProgress;
}

// What a transaction did with respect to this invoice. Keeping the four cases
// apart is the difference between "your payment did not arrive" and a sentence
// that says which of the four mistakes was actually made.
interface TransferScan {
  /** Right token, to our wallet, from the declared payer. */
  fromPayer: bigint;
  /** Right token, to our wallet, but from some other wallet. */
  fromOthers: bigint;
  /** An ERC-20 transfer reached our wallet, but of a different token. */
  otherTokenToUs: boolean;
  /** The chain's native coin was sent to our wallet by the declared payer. */
  nativeToUs: bigint;
  /** Native coin reached our wallet, but from a wallet that is not the payer's. */
  nativeFromOthers: bigint;
}

function scanTransfers(
  receipt: any,
  tx: any,
  token: string,
  payTo: string,
  expectedFrom: string | null
): TransferScan {
  const scan: TransferScan = {
    fromPayer: 0n, fromOthers: 0n, otherTokenToUs: false, nativeToUs: 0n, nativeFromOthers: 0n,
  };

  for (const log of receipt?.logs ?? []) {
    if (!Array.isArray(log.topics) || String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length < 3 || topicToAddress(log.topics[2]) !== payTo) continue;
    if (String(log.address).toLowerCase() !== token) {
      scan.otherTokenToUs = true;
      continue;
    }
    let value: bigint;
    try {
      value = BigInt(log.data);
    } catch {
      continue;
    }
    const sender = topicToAddress(log.topics[1]);
    if (!expectedFrom || sender === expectedFrom) scan.fromPayer += value;
    else scan.fromOthers += value;
  }

  // A native transfer emits no log at all, which is why sending ETH to a USDC
  // invoice used to look identical to sending nothing. The sender is checked the
  // same way as for a token: a native invoice is settled by its declared payer or
  // by nobody.
  try {
    if (tx && String(tx.to ?? "").toLowerCase() === payTo) {
      const from = String(tx.from ?? "").toLowerCase();
      if (!expectedFrom || from === expectedFrom) scan.nativeToUs = BigInt(tx.value ?? "0x0");
      else scan.nativeFromOthers = BigInt(tx.value ?? "0x0");
    }
  } catch {
    /* value unparseable — treat as no native transfer */
  }

  return scan;
}

function hasIntentTerms(intent: PaymentIntent): intent is PaymentIntent & {
  chainId: number;
  tokenDecimals: number;
  minConfirmations: number;
} {
  return (
    intent.chainId !== null &&
    intent.tokenDecimals !== null &&
    intent.minConfirmations !== null &&
    // A token invoice is meaningless without the contract it is written against;
    // a native one is defined by the absence of a contract.
    (intent.payCurrency === "NATIVE" ? !intent.tokenAddress : !!intent.tokenAddress)
  );
}

// Verify a submitted hash against immutable terms copied into the intent, then
// claim the intent and extend the subscription in one database transaction.
export async function verifyPayment(intentId: string, submittedHash: string): Promise<VerifyResult> {
  if (!TX_HASH_RE.test(submittedHash)) return { ok: false, reason: "tx_hash_invalid" };
  const txHash = submittedHash.toLowerCase();

  const intent = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
  if (!intent) return { ok: false, reason: "intent_not_found" };
  if (intent.status === "CONFIRMED") {
    return intent.txHash?.toLowerCase() === txHash
      ? { ok: true, intent, newlyConfirmed: false }
      : { ok: false, reason: "intent_not_pending" };
  }
  if (intent.status !== "PENDING" && intent.status !== "EXPIRED") {
    return { ok: false, reason: "intent_not_pending" };
  }
  if (!hasIntentTerms(intent)) return { ok: false, reason: "intent_terms_missing" };

  const rpcUrl = configuredRpcUrl();
  if (!rpcUrl) return { ok: false, reason: "payments_misconfigured" };

  let receipt: any;
  let head: string;
  let chainIdHex: string;
  let block: any;
  let tx: any;
  try {
    // The transaction itself is fetched alongside the receipt purely so a native
    // coin transfer can be named as such. Without it, sending ETH to an invoice
    // denominated in a token is indistinguishable from sending nothing at all.
    [receipt, head, chainIdHex, tx] = await Promise.all([
      rpc<any>(rpcUrl, "eth_getTransactionReceipt", [txHash]),
      rpc<string>(rpcUrl, "eth_blockNumber", []),
      rpc<string>(rpcUrl, "eth_chainId", []),
      rpc<any>(rpcUrl, "eth_getTransactionByHash", [txHash]).catch(() => null),
    ]);
    if (receipt?.blockNumber) {
      block = await rpc<any>(rpcUrl, "eth_getBlockByNumber", [receipt.blockNumber, false]);
    }
  } catch (error) {
    console.error("[Payments] RPC failure:", error);
    return { ok: false, reason: "rpc_unavailable" };
  }

  if (Number(BigInt(chainIdHex)) !== intent.chainId) return { ok: false, reason: "wrong_chain" };
  if (!receipt) return { ok: false, reason: "tx_not_found" };
  if (receipt.status !== "0x1") return { ok: false, reason: "tx_failed" };
  if (!receipt.blockNumber || !block?.timestamp) return { ok: false, reason: "rpc_unavailable" };

  let confirmations: bigint;
  let paidAt: Date;
  try {
    confirmations = confirmationCount(head, receipt.blockNumber);
    paidAt = new Date(Number(BigInt(block.timestamp)) * 1000);
  } catch {
    return { ok: false, reason: "rpc_unavailable" };
  }
  if (confirmations < BigInt(intent.minConfirmations)) {
    return { ok: false, reason: "tx_not_confirmed" };
  }
  // A payment mined before expiry remains redeemable even if the background
  // sweeper marked the intent expired while the customer was copying the hash.
  if (paidAt.getTime() > intent.expiresAt.getTime()) {
    return { ok: false, reason: "intent_expired" };
  }

  const need = toTokenUnits(intent.amountExact, intent.tokenDecimals);
  const decimals = intent.tokenDecimals;
  const isNative = intent.payCurrency === "NATIVE";
  const token = (intent.tokenAddress ?? "").toLowerCase();
  const payTo = intent.payToAddress.toLowerCase();
  // Count ONLY what the declared payer sent. Crediting every transfer in the
  // transaction would let an invoice be settled by funds someone else moved in
  // the same block of calls, and would still accept a hash lifted off the chain.
  const expectedFrom = intent.expectedFrom?.toLowerCase() ?? null;

  const scan = scanTransfers(receipt, tx, token, payTo, expectedFrom);
  // Which side of the scan settles this invoice is decided by what it was
  // written in, so a token transfer can never pay off a native invoice or the
  // other way round — the two are not interchangeable at any exchange rate the
  // invoice was not quoted at.
  const credited = isNative ? scan.nativeToUs : scan.fromPayer;

  if (credited === 0n) {
    // Each of these used to collapse into one message. Naming the actual mistake
    // is the difference between a customer fixing it in a minute and a customer
    // hunting a problem they do not have: telling someone their wallet is wrong
    // when they in fact sent the wrong currency sends them somewhere useless.
    if (isNative) {
      if (scan.nativeFromOthers > 0n) return { ok: false, reason: "wrong_sender" };
      if (scan.fromPayer > 0n || scan.fromOthers > 0n || scan.otherTokenToUs) {
        return { ok: false, reason: "token_sent_to_native_invoice" };
      }
      return { ok: false, reason: "no_matching_transfer" };
    }
    if (scan.fromOthers > 0n) return { ok: false, reason: "wrong_sender" };
    if (scan.nativeToUs > 0n || scan.nativeFromOthers > 0n) {
      return { ok: false, reason: "native_coin_sent" };
    }
    if (scan.otherTokenToUs) return { ok: false, reason: "wrong_token" };
    return { ok: false, reason: "no_matching_transfer" };
  }

  const fromAddress = expectedFrom ?? null;

  try {
    return await prisma.$transaction(async (db) => {
      // Replay protection spans both the legacy single-hash column and the
      // per-transfer table, so a hash counts exactly once wherever it is offered.
      const usedByIntent = await db.paymentIntent.findUnique({ where: { txHash } });
      if (usedByIntent && usedByIntent.id !== intentId) return { ok: false, reason: "tx_already_used" };

      const already = await db.paymentTransaction.findUnique({ where: { txHash } });
      if (already && already.intentId !== intentId) return { ok: false, reason: "tx_already_used" };
      if (!already) {
        await db.paymentTransaction.create({
          data: {
            intentId,
            txHash,
            amount: credited.toString(),
            fromAddress: fromAddress ?? "unknown",
            blockNumber: String(BigInt(receipt.blockNumber)),
          },
        });
      }

      // Everything accepted against this invoice so far, this transfer included.
      const rows = await db.paymentTransaction.findMany({ where: { intentId } });
      const paid = rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
      const progress: PaymentProgress = {
        paidExact: fromTokenUnits(paid, decimals),
        needExact: intent.amountExact,
        remainingExact: fromTokenUnits(paid >= need ? 0n : need - paid, decimals),
      };

      if (paid < need) {
        // The money is banked, not lost. Push the deadline out so the customer
        // has a full window to send the difference rather than racing whatever
        // was left of the original one.
        const current = await db.paymentIntent.update({
          where: { id: intentId },
          data: {
            fromAddress,
            expiresAt: new Date(Date.now() + INTENT_TTL_HOURS * 60 * 60_000),
          },
        });
        return { ok: false, reason: "partial_payment", intent: current, progress };
      }

      const claimed = await db.paymentIntent.updateMany({
        where: { id: intentId, status: { in: ["PENDING", "EXPIRED"] } },
        data: { status: "CONFIRMED", txHash, fromAddress, confirmedAt: new Date() },
      });
      if (claimed.count !== 1) {
        const current = await db.paymentIntent.findUnique({ where: { id: intentId } });
        if (current?.status === "CONFIRMED") {
          return { ok: true, intent: current, newlyConfirmed: false, progress };
        }
        return { ok: false, reason: "intent_not_pending" };
      }

      await extendSubscription(db, intent.guildId, intent.plan as PlanName, intent.months);
      const confirmed = await db.paymentIntent.findUnique({ where: { id: intentId } });
      if (!confirmed) throw new Error("confirmed_intent_missing");
      return { ok: true, intent: confirmed, newlyConfirmed: true, progress };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, reason: "tx_already_used" };
    }
    console.error("[Payments] Atomic activation failed:", error);
    return { ok: false, reason: "payment_activation_failed" };
  }
}

async function extendSubscription(
  db: Prisma.TransactionClient,
  guildId: string,
  plan: PlanName,
  months: number
): Promise<void> {
  const current = await db.guildSubscription.findUnique({ where: { guildId } });
  const now = Date.now();
  // A trial is time the customer never paid for, so it is carried whole rather
  // than valued; see planChange for why each case behaves the way it does.
  const isTrial =
    !!current?.trialEndsAt &&
    !!current?.activeUntil &&
    current.trialEndsAt.getTime() === current.activeUntil.getTime();

  const change = planChangeFor(
    current ? { plan: current.plan as PlanName, activeUntil: current.activeUntil, isTrial } : null,
    plan,
    months,
    now
  );

  await db.guildSubscription.upsert({
    where: { guildId },
    update: {
      plan: change.plan as never,
      activeUntil: change.activeUntil,
      pendingPlan: (change.pendingPlan as never) ?? null,
      pendingMonths: change.pendingMonths,
      // Clear the lapse latch: a guild that lapsed, paid, and lapses again must
      // be warned the second time too.
      lifecycleNotified: null,
      updatedBy: "CRYPTO_PAYMENT",
    },
    create: {
      guildId,
      plan: change.plan as never,
      activeUntil: change.activeUntil,
      pendingPlan: (change.pendingPlan as never) ?? null,
      pendingMonths: change.pendingMonths,
      updatedBy: "CRYPTO_PAYMENT",
    },
  });
}

// Start a purchase that was parked behind a better plan. Runs from the same
// per-minute sweep as the rest, so a queued downgrade begins the moment the plan
// above it lapses rather than dropping the guild to FREE in between.
export async function activatePendingPlans(): Promise<number> {
  const due = await prisma.guildSubscription.findMany({
    where: { pendingPlan: { not: null }, activeUntil: { lte: new Date() } },
  });
  let started = 0;
  for (const row of due) {
    try {
      const months = row.pendingMonths ?? 1;
      await prisma.guildSubscription.update({
        where: { guildId: row.guildId },
        data: {
          plan: row.pendingPlan as never,
          activeUntil: new Date(Date.now() + months * 30 * 24 * 60 * 60 * 1000),
          pendingPlan: null,
          pendingMonths: null,
          updatedBy: "SCHEDULED_PLAN_CHANGE",
        },
      });
      started++;
    } catch (err) {
      console.error(`[Payments] failed to start scheduled plan for ${row.guildId}:`, err);
    }
  }
  return started;
}

export async function expireStaleIntents(): Promise<number> {
  const result = await prisma.paymentIntent.updateMany({
    where: { status: "PENDING", expiresAt: { lt: new Date() } },
    data: { status: "EXPIRED" },
  });
  return result.count;
}
