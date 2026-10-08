import type Database from "better-sqlite3";
import type { Contract, Provider } from "ethers";
import { insertEvent, getLastScannedBlock, setLastScannedBlock } from "./db";

/**
 * Event indexer (v0): polls the Escrow contract for new logs on an interval
 * and persists every event into SQLite. Polling (rather than subscriptions)
 * is deliberate for v0 — it works over plain JSON-RPC, survives provider
 * reconnects, and the UNIQUE(block_hash, log_index) constraint makes each
 * re-scan idempotent.
 *
 * Known v0 limitation (documented in the README): reorgs are not handled. If
 * a block is reorged away after its events were indexed, the stale rows stay.
 * Acceptable for a testnet MVP; finality handling comes with the ops loop.
 */
export class Indexer {
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;

  constructor(
    private readonly opts: {
      provider: Provider;
      contract: Contract;
      db: Database.Database;
      intervalMs: number;
    }
  ) {}

  /** Scan everything after the last scanned block. Returns rows newly inserted. */
  async tick(): Promise<number> {
    if (this.scanning) return 0; // overlapping ticks (slow scan + interval) skip safely
    this.scanning = true;
    try {
      const { provider, contract, db } = this.opts;
      const last = getLastScannedBlock(db);
      const head = await provider.getBlockNumber();
      if (head <= last) return 0;

      // Scan via provider.getLogs (no topic filter) and decode each log
      // against the contract ABI — matches every event the contract emits.
      const address = await contract.getAddress();
      const logs = await provider.getLogs({ address, fromBlock: last + 1, toBlock: head });
      let inserted = 0;
      for (const log of logs) {
        const parsed = contract.interface.parseLog(log);
        if (!parsed) continue; // unknown topic — skip rather than crash the scan

        const args: Record<string, unknown> = {};
        for (const input of parsed.fragment.inputs) {
          const value = parsed.args[input.name];
          args[input.name] = typeof value === "bigint" ? value.toString() : value;
        }

        const ok = insertEvent(db, {
          name: parsed.name,
          args,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          txHash: log.transactionHash,
          logIndex: log.index,
          indexedAt: new Date().toISOString(),
        });
        if (ok) inserted++;
      }
      setLastScannedBlock(db, head);
      return inserted;
    } finally {
      this.scanning = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error("[indexer] scan failed:", err instanceof Error ? err.message : err);
      });
    }, this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get lastScannedBlock(): number {
    return getLastScannedBlock(this.opts.db);
  }
}
