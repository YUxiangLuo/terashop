import { test } from 'bun:test';
import { verifyOAuthInteraction } from '../support/oauth-interaction';

test(
  'provider interaction binds login, explicit consent and persisted approval before code issuance',
  () => verifyOAuthInteraction(),
  15_000,
);

test(
  'JSON consent completion returns a resume URL without bypassing approval or CSRF',
  () => verifyOAuthInteraction(undefined, true),
  15_000,
);
