import { HostRequestError, isJsonValue, type HostClient, type JsonValue } from '@openchamber/sdk';

// Owner: ledger. A fake host.storage enforcing the host limits and the whole-file rewrite (S5), shared by ledger,
// ui-history and ui-core tests. Every failure is the same HOST_REJECTED, as the host sends it.

export type StorageOp = 'get' | 'set' | 'delete' | 'keys';
export interface FakeStorageStats {
  gets: number; sets: number; deletes: number; keys: number; bytesWritten: number;
  entries: number;                           // keys stored now
  fileBytes: number;                         // the namespace file as serialized now
  setKeys: string[];                         // every `set` key, in order
}
export const HOST_LIMITS = { keyChars: 128, valueBytes: 65_536, totalBytes: 2_097_152, keys: 2_000 } as const;
/** The host's generic refusal (SPIKES S5): namespace full, key limit, not approved and disabled all read the same. */
export const GENERIC_REJECTION = 'Storage operation failed. Check extension approval and storage limits.';
const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;
const rejected = (message = GENERIC_REJECTION) => new HostRequestError('HOST_REJECTED', message);

export type FakeStorage = HostClient['storage'] & { stats(): FakeStorageStats; dump(): Record<string, unknown> };
export interface FakeStorageOptions {
  reject?: (op: StorageOp, key?: string) => boolean;
  initial?: Record<string, unknown>;
  limits?: Partial<Record<keyof typeof HOST_LIMITS, number>>;
}

/**
 * One JSON file per namespace, as the OpenChamber server keeps it: every write re-serializes the whole file (its size is
 * what the 2 MiB limit measures), operations run one at a time, and values go in and come back as copies.
 */
export const createFakeStorage = (options: FakeStorageOptions = {}): FakeStorage => {
  const limits = { ...HOST_LIMITS, ...options.limits };
  let file = JSON.stringify(options.initial ?? {});
  // The parse of `file`, kept in step with it: a read costs one value's copy, a write the whole file's serialization.
  let parsed = JSON.parse(file) as Record<string, JsonValue>;
  const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
  const counts = { gets: 0, sets: 0, deletes: 0, keys: 0, bytesWritten: 0 }, setKeys: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const run = <T>(op: StorageOp, key: string | undefined, work: (values: Record<string, JsonValue>) => T): Promise<T> => {
    // The SDK client refuses a bad key before anything reaches the host.
    if (key !== undefined && (key.length === 0 || key.length > limits.keyChars)) {
      return Promise.reject(rejected(`Storage key must contain 1 to ${limits.keyChars} characters.`));
    }
    const next = queue.then(() => {
      if (options.reject?.(op, key)) throw rejected();
      return work({ ...parsed });
    });
    queue = next.catch(() => undefined);
    return next;
  };
  const write = (values: Record<string, JsonValue>): void => {
    const next = JSON.stringify(values);
    if (bytes(next) > limits.totalBytes || Object.keys(values).length > limits.keys) throw rejected();
    file = next; parsed = values;
    counts.bytesWritten += bytes(next);
  };
  return {
    get: key => run('get', key, values => { counts.gets += 1; return Object.hasOwn(values, key) ? copy(values[key]) : undefined; }),
    set: (key, value) => {
      if (!isJsonValue(value)) return Promise.reject(rejected('Storage values must be JSON.'));
      if (bytes(JSON.stringify(value)) > limits.valueBytes) return Promise.reject(rejected('Storage value exceeds 64 KiB.'));
      // postMessage clones at call time: a value mutated after `set` returns is not what the host stores.
      const clone = copy(value);
      return run('set', key, values => { values[key] = clone; write(values); counts.sets += 1; setKeys.push(key); });
    },
    delete: key => run('delete', key, values => { counts.deletes += 1; if (Object.hasOwn(values, key)) { delete values[key]; write(values); } }),
    keys: () => run('keys', undefined, values => { counts.keys += 1; return Object.keys(values).sort(); }),
    stats: () => ({ ...counts, entries: Object.keys(parsed).length, fileBytes: bytes(file), setKeys: [...setKeys] }),
    dump: () => JSON.parse(file) as Record<string, unknown>,
  };
};
