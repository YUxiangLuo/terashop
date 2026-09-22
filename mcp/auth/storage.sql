-- Apply explicitly to a dedicated authorization database, never via a public API.
-- Run as its non-superuser owner; runtime needs DML only, no schema creation.
create schema oidc;
revoke all on schema oidc from public;

create table oidc.revoked_grants (
  id text primary key,
  revoked_at timestamptz not null default clock_timestamp()
);
create table oidc.artifacts (
  model text not null,
  id text not null,
  payload jsonb,
  expires_at timestamptz,
  grant_id text,
  uid text,
  user_code text,
  consumed bigint,
  destroyed boolean not null default false,
  primary key (model, id),
  check (destroyed = (payload is null))
);
create index on oidc.artifacts (grant_id);
create unique index on oidc.artifacts (uid) where model = 'Session' and not destroyed;
create unique index on oidc.artifacts (user_code) where model = 'DeviceCode' and not destroyed;

-- Recovery metadata only; never store login credentials or provider payloads here.
create table oidc.approval_attempts (
  interaction_id text collate "C" primary key,
  binding jsonb not null check (jsonb_typeof(binding) = 'object'),
  state text not null default 'pending' check (state in ('pending','completed','revoked')),
  created_at timestamptz not null default clock_timestamp()
);
create unique index on oidc.approval_attempts ((binding->>'session_id'));
create index on oidc.approval_attempts (interaction_id) where state='pending';
revoke all on all tables in schema oidc from public;
