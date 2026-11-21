/**
 * Anthropic SDK errors -> one short sentence for the person. Uses the SDK's typed error classes (never the message text),
 * with one exception: an out-of-credit key comes back as a plain 400 whose only marker is its message.
 */
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  OverloadedError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';

export type FailureKind =
  | 'aborted'
  | 'invalid_key'
  | 'no_credit'
  | 'no_access'
  | 'rate_limit'
  | 'overloaded'
  | 'network'
  | 'bad_request'
  | 'unknown';

export interface Failure {
  kind: FailureKind;
  /** Fit to show as is. */
  message: string;
}

/** Anthropic reports "Your credit balance is too low ..." as a 400 invalid_request_error. */
const OUT_OF_CREDIT = /credit balance|billing|purchase credits/i;

export function describeFailure(err: unknown): Failure {
  if (err instanceof APIUserAbortError) return { kind: 'aborted', message: 'Stopped.' };
  if (err instanceof AuthenticationError) {
    return { kind: 'invalid_key', message: 'Anthropic says this API key is not valid. Check it in Settings > Claude API key.' };
  }
  if (err instanceof PaymentRequiredError || (err instanceof BadRequestError && OUT_OF_CREDIT.test(err.message))) {
    return {
      kind: 'no_credit',
      message: 'Your Anthropic account is out of credit. Add credit at console.anthropic.com, then try again.',
    };
  }
  if (err instanceof PermissionDeniedError || err instanceof NotFoundError) {
    return {
      kind: 'no_access',
      message: "This API key can't use the Claude model the Assistant needs. Check your Anthropic account's access.",
    };
  }
  if (err instanceof RateLimitError) {
    return { kind: 'rate_limit', message: 'Anthropic says to slow down (rate limit). Wait a minute and try again.' };
  }
  if (err instanceof OverloadedError) {
    return { kind: 'overloaded', message: 'Claude is busy right now. Try again in a moment.' };
  }
  if (err instanceof APIConnectionTimeoutError) {
    return { kind: 'network', message: 'Claude took too long to answer. Check your connection and try again.' };
  }
  if (err instanceof APIConnectionError) {
    return { kind: 'network', message: "Couldn't reach Anthropic. Check your connection and try again." };
  }
  if (err instanceof BadRequestError) {
    return { kind: 'bad_request', message: 'Anthropic rejected the request. Start a new chat and try again.' };
  }
  if (err instanceof APIError) {
    return { kind: 'unknown', message: `Anthropic had a problem${err.status ? ` (${err.status})` : ''}. Try again in a moment.` };
  }
  return { kind: 'unknown', message: "Something went wrong talking to Claude. Please try again." };
}
