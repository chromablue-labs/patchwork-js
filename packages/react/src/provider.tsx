import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { PatchworkClient } from "@usepatchwork/client";

const PatchworkContext = createContext<PatchworkClient | null>(null);

export interface PatchworkProviderProps {
  url: string;
  mint: () => Promise<string>;
  storageKey?: string;
  connection?: string;
  agent?: string;
  children: ReactNode;
}

export function PatchworkProvider({ url, mint, storageKey, connection, agent, children }: PatchworkProviderProps) {
  const mintRef = useRef(mint);
  mintRef.current = mint;

  const client = useMemo(
    () => new PatchworkClient({ url, storageKey, connection, agent, mint: () => mintRef.current() }),
    [url, storageKey, connection, agent],
  );

  return <PatchworkContext.Provider value={client}>{children}</PatchworkContext.Provider>;
}

export function usePatchworkClient(): PatchworkClient {
  const client = useContext(PatchworkContext);
  if (!client) {
    throw new Error("usePatchworkClient must be used within a <PatchworkProvider>");
  }
  return client;
}
