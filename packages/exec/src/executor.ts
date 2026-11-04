/**
 * Executors turn an approved Order into a Fill.
 *
 *  - PaperExecutor: no transaction. Fills at a live Jupiter quote when a quoter is wired in, otherwise at the
 *    snapshot price with a modelled impact, so paper mode and backtests share one code path.
 *  - JupiterExecutor: quote -> swap transaction -> (Jito: append tip) -> sign (via Signer) -> send (RPC or Jito bundle)
 *    -> confirm -> reconcile the real amounts from the chain.
 */
import {
  AddressLookupTableAccount,
  Connection,
  PACKET_DATA_SIZE,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { Fill, Order, ProjectConfig, Snapshot } from "@tenfold/core";
import { WSOL_MINT, logger } from "@tenfold/core";
import { isTransientHttpError } from "./http.js";
import { JupiterClient, type JupiterQuote, type Quoter } from "./jupiter.js";
import type { Signer } from "./signer.js";
import { ExecError, RETRYABLE_SEND_PATTERN } from "./errors.js";
import { confirmSignature, realSleep, type Sleep } from "./confirm.js";
import { JitoClient } from "./jito.js";
import { AMOUNTS_FROM_QUOTE_NOTE, fetchOnChainFill } from "./reconcile.js";

export { ExecError } from "./errors.js";
export { CONFIRM_TIMEOUT_MS, STATUS_CHECK_ATTEMPTS, STATUS_CHECK_GAP_MS } from "./confirm.js";

export interface Executor {
  /** Execute one approved order against the market described by `snapshot`. */
  execute(order: Order, cfg: ProjectConfig, snapshot: Snapshot): Promise<Fill>;
}

/** Base network fee for a single-signature transaction, lamports. */
export const BASE_TX_FEE_LAMPORTS = 5_000n;

/** Effective price in SOL per whole token from an in/out pair; buy: lamports in, tokens out; sell: inverse. */
export function fillPrice(side: Order["side"], inAmount: bigint, outAmount: bigint, decimals: number): number {
  const lamports = side === "buy" ? inAmount : outAmount;
  const tokens = side === "buy" ? outAmount : inAmount;
  if (tokens === 0n) return 0;
  return Number(lamports) / 1e9 / (Number(tokens) / 10 ** decimals);
}

/** Validate that an order's mints match the project (SOL on one side, the project mint on the other). */
export function assertOrderMints(order: Order, cfg: ProjectConfig): void {
  const expectIn = order.side === "buy" ? WSOL_MINT : cfg.mint;
  const expectOut = order.side === "buy" ? cfg.mint : WSOL_MINT;
  if (order.inputMint !== expectIn || order.outputMint !== expectOut) {
    throw new ExecError(`order ${order.id}: mints ${order.inputMint}->${order.outputMint} do not match a ${order.side} of ${cfg.mint}`, false);
  }
}

/** Modelled paper impact in bps: half the clip's share of pool depth, capped at 500 bps. */
export function paperImpactBps(amountSol: number, liquiditySol: number | undefined): number {
  if (!liquiditySol || liquiditySol <= 0 || amountSol <= 0) return 0;
  return Math.min(500, (amountSol / liquiditySol) * 10_000 / 2);
}

/** Paper fee: 30 bps, matching a typical pool fee. */
export const PAPER_FEE_BPS = 30n;
const BPS = 10_000n;

/**
 * Exact paper fill math on bigint. The price is scaled to an integer with PRICE_SCALE so no float enters the
 * amount computation except through the one rounding of the price itself.
 */
const PRICE_SCALE = 10n ** 18n;

function scaledPrice(price: number): bigint {
  // SOL per token * 1e18, rounded once; prices are in [1e-12, 1e3] so this is exact enough and never overflows.
  return BigInt(Math.round(price * 1e18));
}

/** Tokens (base units) received for `lamports` at `price` SOL/token after `impactBps` + `feeBps`, exact bigint. */
export function paperBuyOut(lamports: bigint, price: number, decimals: number, impactBps: number, feeBps: bigint = PAPER_FEE_BPS): bigint {
  const p = scaledPrice(price);
  if (p === 0n) return 0n;
  // tokens_base = lamports / 1e9 / price * 10^dec = lamports * 10^dec * 1e18 / (1e9 * p)
  const gross = (lamports * 10n ** BigInt(decimals) * PRICE_SCALE) / (1_000_000_000n * p);
  const afterImpact = (gross * (BPS - BigInt(Math.round(impactBps)))) / BPS;
  return (afterImpact * (BPS - feeBps)) / BPS;
}

/** Lamports received for `tokensBase` at `price` SOL/token after `impactBps` + `feeBps`, exact bigint. */
export function paperSellOut(tokensBase: bigint, price: number, decimals: number, impactBps: number, feeBps: bigint = PAPER_FEE_BPS): bigint {
  const p = scaledPrice(price);
  // lamports = tokens_base / 10^dec * price * 1e9 = tokens_base * p * 1e9 / (10^dec * 1e18)
  const gross = (tokensBase * p * 1_000_000_000n) / (10n ** BigInt(decimals) * PRICE_SCALE);
  const afterImpact = (gross * (BPS - BigInt(Math.round(impactBps)))) / BPS;
  return (afterImpact * (BPS - feeBps)) / BPS;
}

export interface PaperExecutorOptions {
  /** When set, paper fills use a live Jupiter quote instead of the modelled price. */
  quoter?: Quoter;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export class PaperExecutor implements Executor {
  private readonly quoter?: Quoter;
  private readonly now: () => number;

  constructor(opts: PaperExecutorOptions = {}) {
    this.quoter = opts.quoter;
    this.now = opts.now ?? Date.now;
  }

  /** Simulate the fill: Jupiter quote if available (falls back to the model on failure), else snapshot price + impact. */
  async execute(order: Order, cfg: ProjectConfig, snapshot: Snapshot): Promise<Fill> {
    assertOrderMints(order, cfg);
    if (order.amountIn <= 0n) throw new ExecError(`order ${order.id}: amountIn is zero`, false);

    let outAmount: bigint | undefined;
    if (this.quoter) {
      try {
        const q = await this.quoter.quote({
          inputMint: order.inputMint,
          outputMint: order.outputMint,
          amount: order.amountIn,
          slippageBps: order.maxSlippageBps,
        });
        outAmount = q.outAmount;
      } catch (e) {
        logger.warn("paper: quote failed, falling back to modelled fill", { orderId: order.id, err: (e as Error).message });
      }
    }
    if (outAmount === undefined) {
      const amountSol =
        order.side === "buy" ? Number(order.amountIn) / 1e9 : (Number(order.amountIn) / 10 ** cfg.decimals) * snapshot.price;
      const impact = paperImpactBps(amountSol, snapshot.liquiditySol);
      outAmount =
        order.side === "buy"
          ? paperBuyOut(order.amountIn, snapshot.price, cfg.decimals, impact)
          : paperSellOut(order.amountIn, snapshot.price, cfg.decimals, impact);
    }
    if (outAmount <= 0n) throw new ExecError(`order ${order.id}: paper fill would yield nothing`, false);

    return {
      orderId: order.id,
      projectId: order.projectId,
      side: order.side,
      reason: order.reason,
      inAmount: order.amountIn,
      outAmount,
      price: fillPrice(order.side, order.amountIn, outAmount, cfg.decimals),
      feeLamports: BASE_TX_FEE_LAMPORTS,
      ts: this.now(),
      paper: true,
    };
  }
}


/** A live Fill plus an optional note (e.g. when amounts had to be taken from the quote). Structurally a Fill. */
export interface ExecFill extends Fill {
  /** Set when something about the fill is approximate; absent on a fully reconciled fill. */
  note?: string;
}

export interface JupiterExecutorOptions {
  /** Cap for Jupiter's "high" priority fee, in micro-lamports per CU; converted to a lamport cap below. */
  priorityFeeMicroLamports: number;
  /** Jito block-engine base URL (e.g. https://mainnet.block-engine.jito.wtf); when set, send via sendBundle with a tip. */
  jitoUrl?: string;
  /** Jito tip, lamports, paid from the wallet inside the swap transaction. Must be > 0 when jitoUrl is set. */
  jitoTipLamports: bigint;
  /** Jupiter client override, for tests. */
  jupiter?: JupiterClient;
  /** Jito client override, for tests; built from jitoUrl otherwise. */
  jito?: JitoClient;
  /** Compute units assumed when converting the micro-lamport price into a lamport cap; default 300k. */
  assumedComputeUnits?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Sleep, injectable for tests. */
  sleep?: Sleep;
  /** Uniform random in [0, 1), injectable for tests; picks the Jito tip account. */
  random?: () => number;
}

interface SentTx {
  sig: string;
  via: "rpc" | "jito";
  /** Jito bundle id when sent as a bundle. */
  bundleId?: string;
  /** Tip actually paid inside the transaction, lamports (0 on the RPC path). */
  tipLamports: bigint;
}

/** A signed, serialized transaction ready to send, with what the confirmation needs. */
interface PreparedTx {
  raw: Uint8Array;
  blockhash: string;
  tipLamports: bigint;
}

export class JupiterExecutor implements Executor {
  private readonly jupiter: JupiterClient;
  private readonly jito?: JitoClient;
  private readonly priorityMaxLamports: bigint;
  private readonly now: () => number;
  private readonly sleep: Sleep;

  constructor(
    private readonly rpc: Connection,
    private readonly signer: Signer,
    private readonly opts: JupiterExecutorOptions,
  ) {
    this.jupiter = opts.jupiter ?? new JupiterClient();
    const cu = BigInt(opts.assumedComputeUnits ?? 300_000);
    // micro-lamports per CU * CU / 1e6 = lamports
    this.priorityMaxLamports = (BigInt(Math.round(opts.priorityFeeMicroLamports)) * cu) / 1_000_000n;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
    if (opts.jitoUrl) {
      if (opts.jitoTipLamports <= 0n) throw new ExecError("jitoTipLamports must be > 0 when jitoUrl is set: an untipped bundle is dropped", false);
      const jitoOpts: ConstructorParameters<typeof JitoClient>[1] = { now: this.now, sleep: this.sleep };
      if (opts.random) jitoOpts.random = opts.random;
      this.jito = opts.jito ?? new JitoClient(opts.jitoUrl, jitoOpts);
    }
  }

  /** Quote, build, sign, send and confirm a Jupiter swap for the order; throws ExecError on any failure. */
  async execute(order: Order, cfg: ProjectConfig, _snapshot: Snapshot): Promise<ExecFill> {
    assertOrderMints(order, cfg);
    if (order.amountIn <= 0n) throw new ExecError(`order ${order.id}: amountIn is zero`, false);
    if (!this.signer.has(cfg.walletPubkey)) throw new ExecError(`no key for wallet ${cfg.walletPubkey}`, false);

    // 1. quote
    let quote: JupiterQuote;
    try {
      quote = await this.jupiter.quote({
        inputMint: order.inputMint,
        outputMint: order.outputMint,
        amount: order.amountIn,
        slippageBps: order.maxSlippageBps,
        restrictIntermediateTokens: true,
      });
    } catch (e) {
      throw new ExecError(`quote failed: ${(e as Error).message}`, isTransientHttpError(e), e);
    }

    // 2. swap transaction
    let swapTx: string;
    let lastValidBlockHeight: number;
    let priorityFeeLamports: bigint;
    try {
      const swap = await this.jupiter.swap(quote, cfg.walletPubkey, { priorityMaxLamports: this.priorityMaxLamports });
      swapTx = swap.swapTransaction;
      lastValidBlockHeight = swap.lastValidBlockHeight;
      priorityFeeLamports = swap.prioritizationFeeLamports !== undefined ? BigInt(Math.round(swap.prioritizationFeeLamports)) : this.priorityMaxLamports;
    } catch (e) {
      throw new ExecError(`swap build failed: ${(e as Error).message}`, isTransientHttpError(e), e);
    }

    // 3. deserialize, add the Jito tip when bundling, sign
    let unsigned: VersionedTransaction;
    try {
      unsigned = VersionedTransaction.deserialize(Buffer.from(swapTx, "base64"));
    } catch (e) {
      throw new ExecError(`swap transaction did not deserialize: ${(e as Error).message}`, false, e);
    }
    const prepared = await this.prepare(unsigned, cfg.walletPubkey);

    // 4. send
    const sent = await this.send(prepared);
    logger.info("tx sent", { orderId: order.id, sig: sent.sig, via: sent.via, bundleId: sent.bundleId });

    // 5. confirm: a landed bundle gives the slot directly; otherwise (RPC path, or bundle status silent for 60 s)
    //    confirm on the signature against the swap's blockhash expiry, then ask the chain when that wait is lost.
    let slot: number | undefined;
    if (sent.via === "jito" && sent.bundleId && this.jito) {
      slot = await this.jito.waitForBundle(sent.bundleId, sent.sig);
      if (slot === undefined) logger.warn("jito bundle status silent, confirming on signature", { sig: sent.sig, bundleId: sent.bundleId });
    }
    if (slot === undefined) slot = await confirmSignature(this.rpc, sent.sig, prepared.blockhash, lastValidBlockHeight, this.sleep);

    // 6. reconcile against the chain; fall back to the quote only when the transaction cannot be read
    const onChain = await fetchOnChainFill(this.rpc, sent.sig, order.side, cfg.walletPubkey, cfg.mint, sent.tipLamports, this.sleep);
    const inAmount = onChain?.inAmount ?? quote.inAmount;
    const outAmount = onChain?.outAmount ?? quote.outAmount;
    const feeLamports = onChain?.feeLamports ?? BASE_TX_FEE_LAMPORTS + priorityFeeLamports + sent.tipLamports;
    if (!onChain) logger.warn("fill amounts taken from the quote", { orderId: order.id, sig: sent.sig });
    const fill: ExecFill = {
      orderId: order.id,
      projectId: order.projectId,
      side: order.side,
      reason: order.reason,
      inAmount,
      outAmount,
      price: fillPrice(order.side, inAmount, outAmount, cfg.decimals),
      feeLamports,
      slot: onChain?.slot ?? slot,
      ts: this.now(),
      txSig: sent.sig,
      paper: false,
    };
    if (!onChain) fill.note = AMOUNTS_FROM_QUOTE_NOTE;
    return fill;
  }

  /**
   * Sign the swap transaction. On the Jito path the tip transfer is appended first: the v0 message is decompiled with
   * its address lookup tables, the SystemProgram.transfer to a tip account is pushed last, and the message is
   * recompiled. When the tipped transaction would exceed the packet size the swap is sent untipped through the RPC.
   */
  private async prepare(unsigned: VersionedTransaction, wallet: string): Promise<PreparedTx> {
    if (this.jito) {
      const tipAccount = await this.jito.pickTipAccount();
      const tipped = await this.appendTip(unsigned, wallet, tipAccount, this.opts.jitoTipLamports);
      this.signer.sign(wallet, tipped);
      const raw = tipped.serialize();
      if (raw.length <= PACKET_DATA_SIZE) return { raw, blockhash: tipped.message.recentBlockhash, tipLamports: this.opts.jitoTipLamports };
      logger.warn("swap tx too large with a Jito tip, sending untipped via RPC", { bytes: raw.length });
    }
    this.signer.sign(wallet, unsigned);
    return { raw: unsigned.serialize(), blockhash: unsigned.message.recentBlockhash, tipLamports: 0n };
  }

  /** Rebuild the unsigned transaction with a SystemProgram.transfer of `lamports` from the wallet to `tipAccount` as its last instruction. */
  private async appendTip(unsigned: VersionedTransaction, wallet: string, tipAccount: string, lamports: bigint): Promise<VersionedTransaction> {
    const msg = unsigned.message;
    let alts: AddressLookupTableAccount[] = [];
    if (msg.version === 0 && msg.addressTableLookups.length > 0) {
      // Fetched in parallel: the swap's blockhash is already ticking.
      alts = await Promise.all(
        msg.addressTableLookups.map(async (lookup) => {
          let res: Awaited<ReturnType<Connection["getAddressLookupTable"]>>;
          try {
            res = await this.rpc.getAddressLookupTable(lookup.accountKey);
          } catch (e) {
            throw new ExecError(`address lookup table ${lookup.accountKey.toBase58()} could not be fetched: ${(e as Error).message}`, true, e);
          }
          if (!res.value) throw new ExecError(`address lookup table ${lookup.accountKey.toBase58()} not found`, false);
          return res.value;
        }),
      );
    }
    let decompiled: TransactionMessage;
    try {
      decompiled = TransactionMessage.decompile(msg, { addressLookupTableAccounts: alts });
    } catch (e) {
      throw new ExecError(`swap transaction could not be decompiled for the tip: ${(e as Error).message}`, false, e);
    }
    decompiled.instructions.push(
      SystemProgram.transfer({ fromPubkey: new PublicKey(wallet), toPubkey: new PublicKey(tipAccount), lamports }),
    );
    return new VersionedTransaction(decompiled.compileToV0Message(alts));
  }

  private async send(prepared: PreparedTx): Promise<SentTx> {
    if (this.jito && prepared.tipLamports > 0n) return this.sendJito(prepared, this.jito);
    try {
      const sig = await this.rpc.sendRawTransaction(prepared.raw, { skipPreflight: false, maxRetries: 3, preflightCommitment: "confirmed" });
      return { sig, via: "rpc", tipLamports: 0n };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Blockhash not found / expired, 429, node behind: retryable. Program errors from preflight are not.
      const retryable = RETRYABLE_SEND_PATTERN.test(msg) || isTransientHttpError(e);
      if (e instanceof SendTransactionError) {
        throw new ExecError(`send rejected: ${e.transactionError.message}`, retryable, e);
      }
      throw new ExecError(`send failed: ${msg}`, retryable, e);
    }
  }

  /** Send the signed, tipped transaction as a one-transaction Jito bundle; the signature is what gets confirmed. */
  private async sendJito(prepared: PreparedTx, jito: JitoClient): Promise<SentTx> {
    const bundleId = await jito.sendBundle([Buffer.from(prepared.raw).toString("base64")]);
    const sig = signatureOf(prepared.raw);
    logger.debug("jito bundle submitted", { bundleId, sig });
    return { sig, via: "jito", bundleId, tipLamports: prepared.tipLamports };
  }
}

/** Base58 signature of a serialized signed VersionedTransaction (its first signature). */
export function signatureOf(raw: Uint8Array): string {
  const tx = VersionedTransaction.deserialize(raw);
  const first = tx.signatures[0];
  if (!first) throw new ExecError("transaction has no signature", false);
  return bs58.encode(first);
}
