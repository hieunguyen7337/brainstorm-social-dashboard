import { ApiError } from '@/src/api';

/** An error whose message is already written for the user (client-side validation before a request). */
export class UiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiError';
  }
}

/** The line to show for a failed call: the API's own message when there is one. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError || e instanceof UiError) return e.message;
  return 'Something went wrong. Please try again.';
}
