import { JsonRpcProvider, Wallet } from "ethers";
import { loadConfig } from "./config";
import { createApp } from "./app";

/**
 * Production-style entrypoint: reads env config, connects to RPC_URL with the
 * operator wallet, opens the indexer DB and serves the API. Boot order is
 * fail-fast: a bad env var or unreachable contract address kills the process
 * before anything listens.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const provider = new JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: true });
  const operator = new Wallet(config.operatorPrivateKey, provider);

  // Fail fast if the escrow address is wrong before opening the port.
  const network = await provider.getNetwork();
  const code = await provider.getCode(config.escrowAddress);
  if (code === "0x") {
    throw new Error(
      `ESCROW_ADDRESS ${config.escrowAddress} has no contract code on chain ${network.chainId} (${config.rpcUrl})`
    );
  }

  const handle = createApp({ config, provider, operator });
  const server = handle.app.listen(config.port, () => {
    console.log(
      `[service] listening on :${config.port} — escrow ${config.escrowAddress}, ` +
        `operator ${operator.address}, chain ${network.chainId}, db ${config.dbPath}`
    );
  });
  handle.start(); // indexer polling

  const shutdown = (signal: string) => {
    console.log(`[service] ${signal} received — shutting down`);
    handle.stop();
    server.close(() => process.exit(0));
    // Fallback if connections linger.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[service] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
