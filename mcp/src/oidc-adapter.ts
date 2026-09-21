import postgres from 'postgres';
import { errors, type Adapter, type AdapterPayload } from 'oidc-provider';

// postgres 3.4.8's TransactionSql uses Omit, which drops its runtime tag signature.
type Transaction = postgres.TransactionSql & {
  (
    strings: TemplateStringsArray,
    ...values: postgres.ParameterOrFragment<never>[]
  ): postgres.PendingQuery<postgres.Row[]>;
};

// One issuer per dedicated database. The caller owns TLS, credentials and pool lifecycle.
// All writes use a short database-wide lock, including across service processes.
// Never perform provider/network work inside this transaction.
export function createOidcAdapter(database: postgres.Sql, clockTolerance = 0) {
  if (!Number.isSafeInteger(clockTolerance) || clockTolerance < 0)
    throw new Error('Invalid OIDC clock tolerance');

  async function write<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    return database.begin('isolation level read committed', async (transaction) => {
      const tx = transaction as Transaction;
      await tx`set local statement_timeout = '10s'`;
      await tx`set local lock_timeout = '5s'`;
      await tx`select pg_advisory_xact_lock(1952805473, 1869177955)`;
      return operation(tx);
    }) as Promise<T>;
  }

  async function revoke(tx: Transaction, grantId: string) {
    await tx`insert into oidc.revoked_grants (id) values (${grantId}) on conflict do nothing`;
    await tx`update oidc.artifacts set destroyed=true, payload=null, uid=null, user_code=null
      where grant_id=${grantId} or (model='Grant' and id=${grantId})`;
  }

  return class OidcAdapter implements Adapter {
    constructor(private readonly model: string) {}

    async upsert(id: string, payload: AdapterPayload, expiresIn?: number) {
      if (expiresIn !== undefined && (!Number.isFinite(expiresIn) || expiresIn < 0))
        throw new Error('Invalid OIDC TTL');
      // Snapshot before awaits; persisted JSON remains extensible to provider fields.
      const value = JSON.parse(JSON.stringify(payload)) as AdapterPayload;
      const grantId = this.model === 'Grant' ? id : (value.grantId ?? null);
      await write(async (tx) => {
        if (grantId) {
          const revoked = await tx`select id from oidc.revoked_grants where id=${grantId}`;
          if (revoked.length) throw new errors.InvalidGrant();
        }
        const [existing] = await tx`select destroyed, consumed, grant_id from oidc.artifacts
          where model=${this.model} and id=${id}`;
        if (existing && (existing.destroyed || existing.grant_id !== grantId))
          throw new errors.InvalidGrant();
        // A stale save cannot clear consumption or alter grant ownership.
        const consumed = existing?.consumed ?? value.consumed ?? null;
        await tx`insert into oidc.artifacts
          (model,id,payload,expires_at,grant_id,uid,user_code,consumed)
          values (${this.model},${id},${tx.json(value as postgres.JSONValue)},
            case when ${expiresIn === undefined} then null
              else clock_timestamp() + ${String((expiresIn ?? 0) + clockTolerance)}::double precision * interval '1 second' end,
            ${grantId},${this.model === 'Session' ? (value.uid ?? null) : null},
            ${this.model === 'DeviceCode' ? (value.userCode ?? null) : null},${consumed})
          on conflict (model,id) do update set payload=excluded.payload,
            expires_at=excluded.expires_at, uid=excluded.uid, user_code=excluded.user_code,
            consumed=excluded.consumed`;
      });
    }

    private async lookup(field: 'id' | 'uid' | 'user_code', value: string) {
      const [row] = await database`select a.payload, a.consumed from oidc.artifacts a
        where a.model=${this.model} and ${database(`a.${field}`)}=${value}
          and not a.destroyed and (a.expires_at is null or a.expires_at > clock_timestamp())
          and not exists (select 1 from oidc.revoked_grants r where r.id=a.grant_id)`;
      if (!row) return undefined;
      return {
        ...row.payload,
        ...(row.consumed === null ? {} : { consumed: Number(row.consumed) }),
      } as AdapterPayload;
    }

    find(id: string) {
      return this.lookup('id', id);
    }
    findByUid(uid: string) {
      return this.model === 'Session' ? this.lookup('uid', uid) : Promise.resolve(undefined);
    }
    findByUserCode(code: string) {
      return this.model === 'DeviceCode' ? this.lookup('user_code', code) : Promise.resolve(undefined);
    }

    async consume(id: string) {
      const accepted = await write(async (tx) => {
        const [row] = await tx`select grant_id, consumed from oidc.artifacts a
          where model=${this.model} and id=${id} and not destroyed
            and (expires_at is null or expires_at > clock_timestamp())
            and not exists (select 1 from oidc.revoked_grants r where r.id=a.grant_id)`;
        if (!row) return false;
        if (row.consumed !== null) {
          // Commit family revocation before rejecting the losing concurrent request.
          if (row.grant_id) await revoke(tx, row.grant_id);
          return false;
        }
        await tx`update oidc.artifacts set consumed=floor(extract(epoch from clock_timestamp()))::bigint
          where model=${this.model} and id=${id}`;
        return true;
      });
      if (!accepted) throw new errors.InvalidGrant();
    }

    async destroy(id: string) {
      await write(async (tx) => {
        if (this.model === 'Grant') await revoke(tx, id);
        await tx`insert into oidc.artifacts (model,id,destroyed) values (${this.model},${id},true)
          on conflict (model,id) do update set destroyed=true,payload=null,uid=null,user_code=null`;
      });
    }

    async revokeByGrantId(grantId: string) {
      await write((tx) => revoke(tx, grantId));
    }
  };
}
