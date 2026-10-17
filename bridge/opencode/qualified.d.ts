import type { CHAT_PROTOCOL } from './compatibility.js';
export type CompatibilityProfile = { id: string; runtimeVersion: string; protocol: typeof CHAT_PROTOCOL; websocketCancellation: 'unit-only' | 'native'; candidate?: true };
export type CompatibilityMode = 'qualified' | 'self-checked' | 'unsupported';
export const QUALIFIED_VERSIONS: string[];
export function profileFor(runtimeVersion: unknown): CompatibilityProfile | null;
export function modeFor(runtimeVersion: unknown): CompatibilityMode;
export function candidateProfile(runtimeVersion: unknown): CompatibilityProfile | null;
