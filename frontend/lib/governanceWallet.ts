import { stellarWallet } from "./stellar-wallet";

/**
 * Sign an unsigned governance transaction XDR with the connected wallet.
 * Connects first if the wallet is not yet connected.
 */
export async function signGovernanceXdr(xdr: string): Promise<string> {
  if (!stellarWallet.isConnected()) {
    await stellarWallet.connect();
  }
  return stellarWallet.signTransaction(xdr);
}

/** Turn a wallet or transaction failure into a message the user can act on. */
export function describeGovernanceError(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  if (/reject|denied|cancel/i.test(message)) {
    return "You rejected the request in your wallet. Nothing was submitted.";
  }
  if (/not installed|not connected|no wallet/i.test(message)) {
    return "Connect your Stellar wallet to continue.";
  }
  return "The transaction failed. Check your connection and try again.";
}
