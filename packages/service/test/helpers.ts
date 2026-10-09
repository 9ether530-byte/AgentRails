import fs from "node:fs";
import { network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  Contract,
  ContractFactory,
  JsonRpcApiProvider,
  Wallet,
  type JsonRpcPayload,
  type JsonRpcResult,
} from "ethers";
import type { Express } from "express";
import type Database from "better-sqlite3";
import { loadEscrowArtifact, loadMockUsdcArtifact } from "../src/abis";
import { createApp, type AppHandle } from "../src/app";

/**
 * Test wiring for the escrow service:
 * - A tiny ethers provider bridge over the in-process hardhat network, so the
 *   SAME production code path (src/server.ts equivalent) runs against a real
 *   chain with no HTTP server in between.
 * - A loadFixture that deploys MockUSDC + Escrow (50 bps fee), funds the
 *   operator with test USDC, opens a fresh SQLite DB and boots the app.
 */

// hardhat node well-known account #0 — TESTS ONLY, never holds anything real.
export const OPERATOR_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const FEE_BPS = 50n;
export const TEST_DB_PATH = "/tmp/ar-service-test.db";

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

/**
 * Bridges hardhat's in-process EIP-1193 provider into an ethers v6 Provider.
 * batchMaxCount: 1 keeps every RPC call individual (hardhat's request() is
 * single-call), cacheTimeout: -1 disables ethers' block-tag cache so tests
 * never read a stale chain view after a mine.
 */
export class HardhatBridgeProvider extends JsonRpcApiProvider {
  constructor(private readonly inner: unknown) {
    super(undefined, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  }

  private async rawRequest(method: string, params: unknown): Promise<unknown> {
    const p = this.inner as any;
    if (typeof p?.request === "function") return p.request({ method, params: params ?? [] });
    return p.send(method, params ?? []); // legacy hardhat fallback
  }

  async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const items = Array.isArray(payload) ? payload : [payload];
    const results: Array<{ id: number; result?: unknown; error?: unknown }> = [];
    for (const item of items) {
      try {
        const result = await this.rawRequest(item.method, (item as { params?: unknown }).params);
        results.push({ id: item.id, result });
      } catch (err) {
        const e = err as { code?: number; message?: string; data?: unknown } | null;
        results.push({
          id: item.id,
          error: {
            code: e?.code ?? -32603,
            message: e?.message ?? "hardhat request failed",
            ...(e?.data !== undefined ? { data: e.data } : {}),
          },
        });
      }
    }
    return results as unknown as JsonRpcResult[];
  }
}

export interface Ctx extends AppHandle {
  operator: Wallet;
  token: Contract;
  tokenAddress: string;
  treasury: string;
  escrowAddress: string;
  provider: HardhatBridgeProvider;
  bumpTime: (seconds: number) => Promise<void>;
}

export const bootFixture = async (): Promise<Ctx> => {
  // Fresh SQLite state for every suite run (fixture runs once; snapshot/revert
  // of the chain would not rewind the filesystem anyway).
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(TEST_DB_PATH + suffix, { force: true });

  const provider = new HardhatBridgeProvider(network.provider);
  const operator = new Wallet(OPERATOR_KEY, provider);

  const token = (await new ContractFactory(
    loadMockUsdcArtifact().abi,
    loadMockUsdcArtifact().bytecode,
    operator
  ).deploy()) as Contract;
  await token.waitForDeployment();
  const tokenAddress = (await token.getAddress()) as string;

  const treasury = Wallet.createRandom().address;
  const escrow = (await new ContractFactory(
    loadEscrowArtifact().abi,
    loadEscrowArtifact().bytecode,
    operator
  ).deploy(operator.address, treasury, FEE_BPS)) as Contract;
  await escrow.waitForDeployment();
  const escrowAddress = (await escrow.getAddress()) as string;

  // 1,000,000 test-USDC (6 decimals) for the operator/buyer.
  await (token.connect(operator) as Contract).mint(operator.address, 1_000_000_000_000n);

  // Background indexer polling off (interval > suite length); tests call
  // indexer.tick() explicitly for deterministic, ordered scans.
  const handle = createApp({
    config: { escrowAddress, dbPath: TEST_DB_PATH, indexerIntervalMs: 3_600_000 },
    provider,
    operator,
  });

  const bumpTime = async (seconds: number): Promise<void> => {
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine", []);
  };

  return { ...handle, operator, token, tokenAddress, treasury, escrowAddress, provider, bumpTime };
};

export const bootOnce = async (): Promise<Ctx> => loadFixture(bootFixture);
