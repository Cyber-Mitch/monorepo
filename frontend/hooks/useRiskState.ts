"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import useRiskStore from "@/store/useRiskStore";

const subscribeToRiskHydration = (onStoreChange: () => void) =>
  useRiskStore.persist.onFinishHydration(onStoreChange);
const getRiskHydrationSnapshot = () => useRiskStore.persist.hasHydrated();
const getServerRiskHydrationSnapshot = () => false;

interface UseRiskStateResult {
  hasHydrated: boolean;
  isFrozen: boolean;
  freezeReason: string | null;
  deficitNgn: number;
  updatedAt: string | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function useRiskState(): UseRiskStateResult {
  const isStoreHydrated = useSyncExternalStore(
    subscribeToRiskHydration,
    getRiskHydrationSnapshot,
    getServerRiskHydrationSnapshot,
  );
  const [hydrationFailed, setHydrationFailed] = useState(false);
  const hasHydrated = isStoreHydrated || hydrationFailed;
  const { 
    isFrozen, 
    freezeReason, 
    deficitNgn, 
    updatedAt, 
    isLoading, 
    fetchRiskState 
  } = useRiskStore();

  useEffect(() => {
    if (!useRiskStore.persist.hasHydrated()) {
      void Promise.resolve(useRiskStore.persist.rehydrate()).catch(() => setHydrationFailed(true));
    }
  }, []);

  useEffect(() => {
    if (hasHydrated) fetchRiskState();
  }, [fetchRiskState, hasHydrated]);

  return { 
    hasHydrated,
    isFrozen, 
    freezeReason, 
    deficitNgn, 
    updatedAt, 
    isLoading, 
    refresh: fetchRiskState 
  };
}
