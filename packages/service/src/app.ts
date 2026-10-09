import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type Database from "better-sqlite3";
import type { Provider, Wallet } from "ethers";
import { Contract } from "ethers";
import { loadEscrowArtifact } from "./abis";
import { AppError, isAppError } from "./errors";
import { openDb } from "./db";
import { Indexer } from "./indexer";
import { buildRouter } from "./routes";
import type { ServiceConfig } from "./config";

export interface CreateAppOptions {
  config: Pick<ServiceConfig, "escrowAddress" | "dbPath" | "indexerIntervalMs">;
  provider: Provider;
  operator: Wallet;
}

export interface AppHandle {
  app: Express;
  escrow: Contract;
  indexer: Indexer;
  db: Database.Database;
  start: () => void;
  stop: () => void;
}

/**
 * Build the express app plus everything it owns (contract handle, SQLite DB,
 * indexer). The HTTP server itself is NOT started here — tests use supertest
 * against `handle.app`, `server.ts` listens.
 */
export function createApp(options: CreateAppOptions): AppHandle {
  const { config, provider, operator } = options;
  const escrow = new Contract(config.escrowAddress, loadEscrowArtifact().abi, operator);
  const db = openDb(config.dbPath);
  const indexer = new Indexer({
    provider,
    contract: escrow,
    db,
    intervalMs: config.indexerIntervalMs,
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/healthz", async (_req: Request, res: Response) => {
    try {
      const network = await provider.getNetwork();
      res.status(200).json({
        ok: true,
        chainId: network.chainId.toString(),
        escrow: config.escrowAddress,
        operator: operator.address,
        indexer: { lastScannedBlock: indexer.lastScannedBlock, intervalMs: config.indexerIntervalMs },
        uptimeSec: Math.floor(process.uptime()),
      });
    } catch {
      res.status(503).json({ ok: false, error: { code: "RPC_UNREACHABLE", message: "JSON-RPC endpoint unreachable" } });
    }
  });

  app.use(buildRouter({ escrow, operator, escrowAddress: config.escrowAddress, db }));

  // Unknown route -> JSON envelope.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "no such route" } });
  });

  // Central error handler -> JSON envelope { error: { code, message, details? } }.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in (err as object)) {
      res.status(400).json({ error: { code: "INVALID_JSON", message: "request body is not valid JSON" } });
      return;
    }
    if (isAppError(err)) {
      const payload: Record<string, unknown> = { code: err.code, message: err.message };
      if (err.details !== undefined) payload.details = err.details;
      res.status(err.status).json({ error: payload });
      return;
    }
    console.error("[service] unhandled error:", err);
    res.status(500).json({ error: { code: "INTERNAL", message: "internal server error" } });
  });

  return {
    app,
    escrow,
    indexer,
    db,
    start: () => indexer.start(),
    stop: () => {
      indexer.stop();
      db.close();
    },
  };
}

export function appError(status: number, code: string, message: string): AppError {
  return new AppError(status, code, message);
}
