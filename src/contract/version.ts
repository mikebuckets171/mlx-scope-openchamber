/** Wire contract v2 (docs/design/2.0-contract.md). A 1.x panel gets `RETIRED_BODY` from `/snapshot`. */
export const CONTRACT_VERSION = 2 as const;
export type ContractVersion = typeof CONTRACT_VERSION;

export const ROUTES = {
  health: '/health', snapshot: '/v2/snapshot', trend: '/v2/trend', usage: '/v2/usage', retired: '/snapshot',
} as const;
export const RETIRED_STATUS = 410;
export const RETIRED_BODY = { error: 'contract_mismatch', contractVersion: CONTRACT_VERSION } as const;
export const NOT_FOUND_BODY = { error: 'not_found' } as const;
export const badQuery = (param: string) => ({ error: 'bad_query', param }) as const;
