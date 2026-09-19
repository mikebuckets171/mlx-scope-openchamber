export type RuntimeRead = (path: string) => Promise<Record<string, unknown> | null>;
