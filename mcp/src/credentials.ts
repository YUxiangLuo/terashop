import * as z from 'zod/v4';

const keyId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const contextSchema = z.strictObject({
  project: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => value.trim().length > 0),
  grantId: z.uuid(),
  userId: z.uuid(),
  revision: z.number().int().positive(),
});
const token = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[\x21-\x7e]+$/);
const credentialsSchema = z.strictObject({
  accessToken: token,
  refreshToken: token,
  // Supabase expires_at: Unix seconds. Expired access tokens may still need refreshing.
  expiresAt: z.number().int().positive(),
});
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  keyId,
  iv: z.string().length(16),
  ciphertext: z.string().min(22).max(65536),
});

export type CredentialContext = z.infer<typeof contextSchema>;
export type DownstreamCredentials = z.infer<typeof credentialsSchema>;
export type CredentialEnvelope = z.infer<typeof envelopeSchema>;

function decode(value: string): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new Error('Invalid encoding');
  return new Uint8Array(bytes);
}

function additionalData(context: CredentialContext, id: string): Uint8Array<ArrayBuffer> {
  const c = contextSchema.parse(context);
  // Fixed-order, domain-separated encoding, independent of object property order.
  return new TextEncoder().encode(
    JSON.stringify(['tera-mcp-downstream-credentials', 1, id, c.project, c.grantId, c.userId, c.revision]),
  );
}

// Host-only cryptography, not a credential store or an authorization check.
// Context/revision must come from trusted grant/storage state, not the envelope.
// Keys are provisioned separately from the database; no environment or default key.
export async function createCredentialCipher(material: ReadonlyMap<string, Uint8Array>, activeKeyId: string) {
  let keys: Map<string, CryptoKey>;
  try {
    keyId.parse(activeKeyId);
    const entries = [...material].map(([id, bytes]) => {
      keyId.parse(id);
      if (bytes.length !== 32) throw new Error('Expected AES-256 key');
      return [id, new Uint8Array(bytes)] as const;
    });
    if (!entries.some(([id]) => id === activeKeyId)) throw new Error('Missing active key');
    keys = new Map(
      await Promise.all(
        entries.map(async ([id, bytes]) => {
          try {
            return [
              id,
              await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']),
            ] as const;
          } finally {
            bytes.fill(0);
          }
        }),
      ),
    );
  } catch {
    throw new Error('INVALID_CREDENTIAL_KEY_CONFIGURATION');
  }

  return {
    async seal(context: CredentialContext, credentials: DownstreamCredentials): Promise<CredentialEnvelope> {
      let plaintext: Uint8Array<ArrayBuffer> | undefined;
      try {
        const aad = additionalData(context, activeKeyId);
        plaintext = new TextEncoder().encode(JSON.stringify(credentialsSchema.parse(credentials)));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
          keys.get(activeKeyId)!,
          plaintext,
        );
        return {
          version: 1,
          keyId: activeKeyId,
          iv: Buffer.from(iv).toString('base64url'),
          ciphertext: Buffer.from(encrypted).toString('base64url'),
        };
      } catch {
        throw new Error('CREDENTIAL_ENCRYPTION_FAILED');
      } finally {
        plaintext?.fill(0);
      }
    },
    async open(context: CredentialContext, envelope: unknown): Promise<DownstreamCredentials> {
      let plaintext: Uint8Array<ArrayBuffer> | undefined;
      try {
        const parsed = envelopeSchema.parse(envelope);
        const key = keys.get(parsed.keyId);
        if (!key) throw new Error('Unknown key');
        plaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: decode(parsed.iv),
              additionalData: additionalData(context, parsed.keyId),
              tagLength: 128,
            },
            key,
            decode(parsed.ciphertext),
          ),
        );
        return credentialsSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)),
        );
      } catch {
        throw new Error('CREDENTIAL_DECRYPTION_FAILED');
      } finally {
        plaintext?.fill(0);
      }
    },
  };
}
