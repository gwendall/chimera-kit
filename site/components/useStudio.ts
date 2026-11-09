import { useSyncExternalStore } from "react";
import { studio } from "@/lib/studio";

export function useStudio() {
  return useSyncExternalStore(studio.subscribe, studio.getSnapshot, studio.getSnapshot);
}
