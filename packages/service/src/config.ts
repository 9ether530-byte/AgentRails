export interface ServiceConfig {
  port: number;
  rpcUrl: string;
  escrowAddress: string;
  operatorPrivateKey: string;
  dbPath: string;
  indexerIntervalMs: number;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env var ${name} (see .env.example)`);
  }
  return value.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    port: Number.parseInt(env.PORT ?? "3001", 10),
    rpcUrl: env.RPC_URL ?? "http://127.0.0.1:8545",
    escrowAddress: requireEnv(env, "ESCROW_ADDRESS"),
    operatorPrivateKey: requireEnv(env, "OPERATOR_PRIVATE_KEY"),
    dbPath: env.DB_PATH ?? "data/agentrails.db",
    indexerIntervalMs: Number.parseInt(env.INDEXER_INTERVAL_MS ?? "2000", 10),
  };
}
