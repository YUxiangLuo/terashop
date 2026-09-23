import postgres from 'postgres';

// This module is an explicit host-side maintenance API. It is intentionally not
// wired to an HTTP handler, service lifecycle, or MCP tool.
export const MAX_OIDC_CLEANUP_BATCH = 1_000;

export interface OidcInvalidationCounts {
  artifactsInvalidated: number;
  grantsRevoked: number;
}

// A multi-statement SIMPLE query is one implicit PostgreSQL transaction. Locks,
// mutation and counts share the connection and roll back together on any error.
// No JS rollback is sent after a lost socket (postgres 3.4.8's begin callback
// attempts that and can crash). Each SQL command gets a fresh RC snapshot after
// the writer barrier. Only static internal SQL and a validated integer enter here.
async function maintain(database: postgres.Sql, statement: string) {
  const results = await database
    .unsafe(
      `
    set transaction isolation level read committed;
    set local statement_timeout = '30s';
    set local lock_timeout = '5s';
    do $$ begin
      if not pg_try_advisory_xact_lock(1952805473, 1869177956) then
        raise exception 'OIDC_MAINTENANCE_OWNER_LOCKED';
      end if;
    end $$;
    select pg_advisory_xact_lock(1952805473, 1869177955);
    ${statement}
  `,
    )
    .simple();
  return results.at(-1) as unknown as postgres.Row[];
}

/**
 * Conservatively invalidate every artifact from a restored issuer snapshot.
 * Grant ownership and consumption evidence remain on artifact tombstones.
 */
export async function invalidateRestoredOidcAuthorization(
  database: postgres.Sql,
): Promise<OidcInvalidationCounts> {
  const [counts] = await maintain(
    database,
    `with abandoned as (
      update oidc.approval_attempts a set state='pending'
      where a.state='completed' and exists (
        select 1 from oidc.artifacts i where i.model='Interaction'
          and i.id=a.interaction_id and not i.destroyed)
      returning 1), grants as (
      insert into oidc.revoked_grants(id)
      select grant_value from (
        select id as grant_value from oidc.artifacts where model='Grant'
        union
        select grant_id as grant_value from oidc.artifacts where grant_id is not null
      ) known
      on conflict do nothing
      returning 1), artifacts as (
      update oidc.artifacts
      set destroyed=true,payload=null,uid=null,user_code=null
      where not destroyed or payload is not null or uid is not null or user_code is not null
      returning 1)
    select (select count(*)::integer from artifacts) as artifacts,
      (select count(*)::integer from grants) as grants;
  `,
  );
  return { artifactsInvalidated: counts.artifacts, grantsRevoked: counts.grants };
}

/**
 * Scrub at most `limit` expired provider payloads while retaining artifact rows
 * as permanent model/id, grant ownership, and consumption tombstones.
 */
export async function cleanupExpiredOidcPayloads(database: postgres.Sql, limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OIDC_CLEANUP_BATCH)
    throw new Error(`OIDC cleanup limit must be an integer from 1 to ${MAX_OIDC_CLEANUP_BATCH}`);

  const [counts] = await maintain(
    database,
    `
      with candidates as materialized (
        select model, id
        from oidc.artifacts
        where not destroyed and payload is not null
          and expires_at is not null and expires_at <= clock_timestamp()
        order by expires_at, model, id
        limit ${limit}
        for update
      ), abandoned as (
        update oidc.approval_attempts a set state='pending'
        from candidates c where c.model='Interaction' and c.id=a.interaction_id
          and a.state='completed'
        returning 1
      ), changed as (
      update oidc.artifacts a
      set destroyed=true, payload=null, uid=null, user_code=null
      from candidates c
      where a.model=c.model and a.id=c.id
      returning 1)
      select count(*)::integer as count from changed;
  `,
  );
  return counts.count;
}
