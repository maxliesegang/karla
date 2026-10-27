/** The network this build reads, chosen by `VITE_NETWORK` (default `kvv`). */
import { kvvNetwork } from "./kvv/kvv-network";
import type { NetworkDefinition } from "./network-definition";

const networks: Readonly<Record<string, NetworkDefinition>> = { kvv: kvvNetwork };

function selectNetwork(name = "kvv"): NetworkDefinition {
  const selected = networks[name];
  if (!selected)
    throw new Error(`VITE_NETWORK=${name} names no network (${Object.keys(networks)})`);
  return selected;
}

export const network: NetworkDefinition = selectNetwork(import.meta.env?.VITE_NETWORK || undefined);
