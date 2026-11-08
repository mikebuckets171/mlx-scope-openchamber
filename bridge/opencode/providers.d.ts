export function namesSplash(id: string, name: string): boolean;
export function splashOptions(input?: { providerID?: unknown; baseURL?: unknown }): { providerID: string; origin: string; endpointKey: string };
export function createSplashLookup(options: {
  list: () => Promise<unknown[]>; now?: () => number; ttlMs?: number; retryMs?: number; firstWaitMs?: number;
}): (providerID: unknown) => Promise<{ providerID: string; origin: string; endpointKey: string } | null>;
