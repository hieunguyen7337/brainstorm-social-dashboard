import Anthropic from '@anthropic-ai/sdk';

import { describeFailure } from './errors';

const h = new Headers();

describe('describeFailure', () => {
  it.each([
    ['invalid_key', new Anthropic.AuthenticationError(401, { error: { message: 'invalid x-api-key' } }, 'invalid', h)],
    ['no_credit', new Anthropic.PaymentRequiredError(402, undefined, 'pay', h)],
    ['no_credit', new Anthropic.BadRequestError(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } },
      undefined,
      h,
    )],
    ['no_access', new Anthropic.PermissionDeniedError(403, undefined, 'no', h)],
    ['rate_limit', new Anthropic.RateLimitError(429, undefined, 'slow', h)],
    ['overloaded', new Anthropic.OverloadedError(529, undefined, 'busy', h)],
    ['network', new Anthropic.APIConnectionError({ message: 'offline' })],
    ['network', new Anthropic.APIConnectionTimeoutError()],
    ['bad_request', new Anthropic.BadRequestError(400, undefined, 'bad', h)],
    ['unknown', new Anthropic.InternalServerError(500, undefined, 'boom', h)],
    ['unknown', new Error('whatever')],
    ['aborted', new Anthropic.APIUserAbortError()],
  ])('maps to %s', (kind, err) => {
    const f = describeFailure(err);
    expect(f.kind).toBe(kind);
    expect(f.message).toBeTruthy();
  });

  it('never repeats raw server text or an api key in the message', () => {
    const f = describeFailure(new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key sk-ant-secret', h));
    expect(f.message).not.toContain('sk-ant-secret');
  });
});
