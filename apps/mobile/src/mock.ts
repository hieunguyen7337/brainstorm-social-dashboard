/**
 * In-memory fake of the Pulse API (EXPO_PUBLIC_MOCK=1, and the offline-demo fallback).
 * PLACEHOLDER: the mock unit replaces this file. It must keep these two exports.
 */
import { ApiError } from './http';
import type { PulseApi } from './types';

const notReady = (): Promise<never> => Promise.reject(new ApiError(0, 'mock API not implemented yet'));

export const mockApi: PulseApi = new Proxy({} as PulseApi, {
  get: () => notReady,
});

/** Simulate a real person tapping a tracked link (`/r/<code>`), optionally converting on the landing page. */
export function mockClickLink(_code: string, _convert = false): void {}
