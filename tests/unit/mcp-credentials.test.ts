import { expect, test } from 'bun:test';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { createCredentialCipher, type CredentialContext } from '../../mcp/src/credentials';

const context: CredentialContext = {
  project: 'shop-a',
  grantId: '05822dd2-14d7-47a5-8db9-5c2f179404b0',
  userId: '8f2ef6ea-378e-42a5-84f7-2a573e25a022',
  revision: 7,
};
const credentials = {
  accessToken: 'fixture-access.jwt',
  refreshToken: 'fixture-refresh-secret',
  expiresAt: 1700000000,
};
const key = Uint8Array.from({ length: 32 }, (_, i) => i);
// Independently specified wire format, not derived from implementation output.
const aad = Buffer.from(
  '["tera-mcp-downstream-credentials",1,"key-a","shop-a","05822dd2-14d7-47a5-8db9-5c2f179404b0","8f2ef6ea-378e-42a5-84f7-2a573e25a022",7]',
);

test('credential envelopes interoperate with AES-256-GCM and use a fresh nonce per write', async () => {
  const cipher = await createCredentialCipher(new Map([['key-a', key]]), 'key-a');
  const first = await cipher.seal(context, credentials);
  const second = await cipher.seal(context, credentials);
  expect(first.iv).not.toBe(second.iv);
  expect(first.ciphertext).not.toBe(second.ciphertext);
  expect(Object.keys(first).sort()).toEqual(['ciphertext', 'iv', 'keyId', 'version']);
  expect(await cipher.open(context, JSON.parse(JSON.stringify(first)))).toEqual(credentials);
  const bytes = Buffer.from(first.ciphertext, 'base64url');
  const decoder = createDecipheriv('aes-256-gcm', key, Buffer.from(first.iv, 'base64url'));
  decoder.setAAD(aad);
  decoder.setAuthTag(bytes.subarray(-16));
  expect(
    JSON.parse(Buffer.concat([decoder.update(bytes.subarray(0, -16)), decoder.final()]).toString()),
  ).toEqual(credentials);

  const iv = Buffer.alloc(12, 9);
  const encoder = createCipheriv('aes-256-gcm', key, iv);
  encoder.setAAD(aad);
  const ciphertext = Buffer.concat([
    encoder.update(JSON.stringify(credentials)),
    encoder.final(),
    encoder.getAuthTag(),
  ]);
  expect(
    await cipher.open(context, {
      version: 1,
      keyId: 'key-a',
      iv: iv.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    }),
  ).toEqual(credentials);
});

test('ciphertext cannot be transplanted between projects, grants, users or revisions', async () => {
  const cipher = await createCredentialCipher(new Map([['key-a', key]]), 'key-a');
  const sealed = await cipher.seal(context, credentials);
  for (const change of [
    { project: 'shop-b' },
    { project: ' shop-a' },
    { grantId: crypto.randomUUID() },
    { userId: crypto.randomUUID() },
    { revision: 6 },
    { revision: 8 },
  ])
    await expect(cipher.open({ ...context, ...change }, sealed)).rejects.toThrow(
      /^CREDENTIAL_DECRYPTION_FAILED$/,
    );
  expect(
    await cipher.open(
      { revision: 7, userId: context.userId, grantId: context.grantId, project: 'shop-a' },
      sealed,
    ),
  ).toEqual(credentials);
});

test('tampered headers, payloads and tags fail closed with no key or credential details', async () => {
  // Same key bytes under another identifier prove key ID is authenticated, not just looked up.
  const cipher = await createCredentialCipher(
    new Map([
      ['key-a', key],
      ['alias', key],
    ]),
    'key-a',
  );
  const sealed = await cipher.seal(context, credentials);
  const corrupted = (position: number) => {
    const bytes = Buffer.from(sealed.ciphertext, 'base64url');
    bytes[position < 0 ? bytes.length + position : position] ^= 1;
    return bytes.toString('base64url');
  };
  for (const change of [
    { version: 2 },
    { keyId: 'missing' },
    { keyId: 'alias' },
    { iv: Buffer.alloc(12).toString('base64url') },
    { ciphertext: corrupted(0) },
    { ciphertext: corrupted(-1) },
    { ciphertext: `${sealed.ciphertext}=` },
    { ciphertext: 'x'.repeat(65537) },
    { iv: '????????????????' },
    { accessToken: 'must-not-be-returned' },
  ])
    await expect(cipher.open(context, { ...sealed, ...change })).rejects.toThrow(
      /^CREDENTIAL_DECRYPTION_FAILED$/,
    );
});

test('rotation reads retained keys, writes the active key and stops reading retired keys', async () => {
  const old = await createCredentialCipher(new Map([['key-a', key]]), 'key-a');
  const sealed = await old.seal(context, credentials);
  const nextKey = new Uint8Array(32).fill(99);
  const ring = new Map([
    ['key-a', new Uint8Array(key)],
    ['key-b', nextKey],
  ]);
  const rotated = await createCredentialCipher(ring, 'key-b');
  // Imported keys are snapshots; mutation of the source cannot change the cipher.
  ring.clear();
  nextKey.fill(0);
  expect(await rotated.open(context, sealed)).toEqual(credentials);
  const rewritten = await rotated.seal({ ...context, revision: 8 }, await rotated.open(context, sealed));
  expect(rewritten.keyId).toBe('key-b');
  const retired = await createCredentialCipher(new Map([['key-b', new Uint8Array(32).fill(99)]]), 'key-b');
  expect(await retired.open({ ...context, revision: 8 }, rewritten)).toEqual(credentials);
  await expect(retired.open(context, sealed)).rejects.toThrow(/^CREDENTIAL_DECRYPTION_FAILED$/);
  await expect(old.open({ ...context, revision: 8 }, rewritten)).rejects.toThrow(
    /^CREDENTIAL_DECRYPTION_FAILED$/,
  );
});

test('invalid key configuration, context and plaintext are rejected without leaking inputs', async () => {
  for (const keys of [
    new Map<string, Uint8Array>(),
    new Map([['key-a', new Uint8Array(31)]]),
    new Map([['secret/key-name', key]]),
  ]) {
    await expect(createCredentialCipher(keys, 'key-a')).rejects.toThrow(
      /^INVALID_CREDENTIAL_KEY_CONFIGURATION$/,
    );
  }
  const cipher = await createCredentialCipher(new Map([['key-a', key]]), 'key-a');
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    await expect(cipher.seal({ ...context, revision }, credentials)).rejects.toThrow(
      /^CREDENTIAL_ENCRYPTION_FAILED$/,
    );
  for (const value of [
    { ...credentials, accessToken: '' },
    { ...credentials, refreshToken: 'secret\nvalue' },
    { ...credentials, expiresAt: 0 },
    { ...credentials, password: 'not-supported' },
  ])
    await expect(cipher.seal(context, value)).rejects.toThrow(/^CREDENTIAL_ENCRYPTION_FAILED$/);
  const largest = { accessToken: 'a'.repeat(16384), refreshToken: 'b'.repeat(16384), expiresAt: 1 };
  expect(await cipher.open(context, await cipher.seal(context, largest))).toEqual(largest);
  await expect(cipher.seal(context, { ...largest, accessToken: 'a'.repeat(16385) })).rejects.toThrow(
    /^CREDENTIAL_ENCRYPTION_FAILED$/,
  );
});

test('authenticated but invalid credential payloads are rejected after decryption', async () => {
  const cipher = await createCredentialCipher(new Map([['key-a', key]]), 'key-a');
  for (const plaintext of [
    'not-json',
    JSON.stringify({ ...credentials, refreshToken: null }),
    JSON.stringify({ ...credentials, serviceRoleKey: 'forbidden' }),
  ]) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = createCipheriv('aes-256-gcm', key, iv);
    encoder.setAAD(aad);
    const ciphertext = Buffer.concat([encoder.update(plaintext), encoder.final(), encoder.getAuthTag()]);
    await expect(
      cipher.open(context, {
        version: 1,
        keyId: 'key-a',
        iv: Buffer.from(iv).toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
      }),
    ).rejects.toThrow(/^CREDENTIAL_DECRYPTION_FAILED$/);
  }
});
