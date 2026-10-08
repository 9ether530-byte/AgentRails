import type { ContractMethod, ContractTransactionReceipt } from "ethers";
import { AppError, mapRevertError } from "./errors";

export interface TxOutcome {
  txHash: string;
  blockNumber: number;
  receipt: ContractTransactionReceipt;
}

/**
 * Send a state-changing transaction with a pre-flight simulation:
 * 1. staticCall first — reverts surface as clean, decoded 4xx errors without
 *    spending gas on a doomed transaction;
 * 2. send + wait — a revert after broadcast (e.g. race between check and
 *    mine) maps through the same revert translation.
 */
export async function execTx(method: ContractMethod): Promise<TxOutcome> {
  try {
    await method.staticCall();
  } catch (err) {
    throw mapRevertError(err);
  }

  let tx;
  try {
    tx = await method.send();
  } catch (err) {
    throw mapRevertError(err);
  }

  let receipt: ContractTransactionReceipt | null;
  try {
    receipt = await tx.wait();
  } catch (err) {
    throw mapRevertError(err);
  }
  if (!receipt || receipt.status !== 1) {
    throw new AppError(500, "TX_FAILED", `transaction ${tx?.hash ?? "?"} did not succeed`);
  }
  return { txHash: tx.hash, blockNumber: receipt.blockNumber, receipt };
}
