# Remote MCP single-instance operations

This runbook covers one directly TLS-terminating authorization process and one directly TLS-terminating MCP process for one fixed issuer/resource pair. It does **not** make this deployment production-ready by itself. Dynamic client registration, reverse proxies, load balancing, multiple active instances, and online key migration are out of scope.

## Release and trust boundary

- Pin the repository revision, Bun `1.4.2`, Node 22 LTS, dependencies from `bun.lock`, and deployment image digests. Install/build in CI with `bun install --frozen-lockfile`; do not build on the production host.
- Build the authorization entry point as the existing compatibility harness does:

  ```sh
  bun build mcp/src/auth.ts --target=node --outfile=dist/auth.mjs --external=oidc-provider --external=postgres
  bun build mcp/src/maintenance.ts --target=node --outfile=dist/maintenance.mjs --external=postgres
  ```

  Run `dist/auth.mjs` and `dist/maintenance.mjs` only with Node 22 LTS, with their pinned external dependencies alongside the build. Both entry points reject Bun. Maintenance uses one implicit PostgreSQL transaction in a simple-query batch: fault injection found that the pinned driver's callback transaction wrapper can attempt rollback on a dead socket in both runtimes. The maintenance command avoids that wrapper and its connection-loss behavior is tested in the issuer's supported Node runtime. The MCP entry point is run by Bun 1.4.2 from the pinned checkout (or an equivalently reviewed Bun-target bundle).
- Before release, run the checks that exist in this repository:

  ```sh
  bun run typecheck
  bun run test:unit
  bun run docs:check
  bun scripts/mcp-oidc-compat.ts
  bun scripts/mcp-oidc-compat.ts --with-storage
  ```

  The two compatibility commands use disposable Docker fixtures; they do not prove production Supabase, DNS, certificates, firewalling, backups, or a real browser flow. Use `bun run test:current --integration` against the CLI-selected disposable **local** Supabase; `bun run test` additionally resets local data. Browser acceptance is automated and opt-in (`MCP_BROWSER=1 bun run test:current tests/mcp-oidc-interaction.test.ts -t 'node:'`), requiring agent-browser, Chromium and certutil. Never point these fixtures at production.

## Provisioning

### Admin integration upgrade

Apply the shop migrations through `20260924000004_mcp_approval_cart_versions.sql` before upgrading the remote MCP host and Admin build. The new host fails closed if approval RPCs are unavailable; do not bypass this by reverting to raw high-risk dispatch. The audit RPC replaces its prior signature with compatible optional resource arguments, not an ambiguous overload. Keep the shop schema and generated `types/database.ts` at the same revision.

The cart-version migration invalidates previously staged customer/user anonymization fingerprints, including already approved requests that have not executed. Inspect current business state and obtain a fresh approval; do not rewrite stored fingerprints to preserve old approvals. New approvals bind cart IDs and versions and reject edits made before consumption.

The five high-risk remote tools now stage human approvals. Confirm the Admin `/approvals` route is reachable after independent login, then verify a disposable role change through stage → approve → exact replay and rejection/expiry. Never use a real refund for a smoke test. `consuming` requires business reconciliation, not an automatic retry; `consumed` is not payment settlement. Keep original approval IDs and refund idempotency keys. Admin manual bookkeeping remains on its existing preview/commit contract.

Keep `PUBLIC_MCP_CONNECTION` resource, issuer and scopes aligned with the trusted authorization/MCP configurations and pre-registered clients. Keep `adminOrigin` an exact HTTPS origin. Public configuration display is not a health check. Enable auditing deliberately; resource links contain no token and confer no permission. Realtime may be rate-limited and is not a durable event log; approval recovery uses explicit reads. Production DNS/TLS, target Agent clients, quotas, backups and key-rotation rehearsal remain separate release gates requiring deployment authorization.

### Authorization database

Use a dedicated PostgreSQL database, not the shop database. During a reviewed maintenance window, its non-superuser schema owner applies `mcp/auth/storage.sql` with `psql -v ON_ERROR_STOP=1 -f mcp/auth/storage.sql`. This is the only initial schema supplied here; there is no application auto-migration.

Create a distinct runtime login. Grant it only `USAGE` on schema `oidc` and `SELECT, INSERT, UPDATE, DELETE` on `oidc.artifacts`, `oidc.revoked_grants`, and `oidc.approval_attempts`. It must not be superuser, own/create databases or roles, bypass RLS, or have schema `CREATE`; startup enforces these properties. Require encrypted PostgreSQL transport with hostname validation (the service uses `verify-full` except for loopback), restrict network access to the authorization host, and keep owner/backup credentials unavailable to the processes.

### Host configuration and TLS

Supply each process one absolute path to a regular, non-symlink JSON file, at most 64 KiB and mode `0600`, owned/readable only by its unprivileged service account. Protect its parent directory as well; symlink-based Secret volumes are unsupported. Pass no secret in environment variables, argv, unit names, or working-directory files. Exact schemas are defined in [oidc-service.ts](src/oidc-service.ts), [oidc-provider.ts](src/oidc-provider.ts) and [http-service.ts](src/http-service.ts); validate changes in staging rather than adding undocumented fields.

The authorization configuration contains `provider`, dedicated `databaseUrl`, `downstream`, `credentialKeys`, `activeCredentialKey`, `tls`, and `listen`. The MCP configuration contains `authorization`, the same credential key ring, `activeCredentialKey`, `tls`, and `listen`. Important invariants:

- `provider.issuer` and `authorization.issuer` are the same fixed HTTPS origin; `provider.resource` and `authorization.resource` are the same fixed HTTPS MCP URL (with a non-root path). The introspection endpoint is the issuer's fixed metadata value and its origin must equal the issuer.
- `provider.clients` is a reviewed static allow-list of `id/applicationType/redirectUris`. Web callbacks require HTTPS; native callbacks support literal HTTP loopback (`127.0.0.1` / `::1`), not localhost, custom schemes, query or fragment. There is no dynamic registration.
- Optional MCP `authorization.adminOrigin` (for example `https://admin.example.com`) enables Admin navigation links on product/order/customer/checkout-quote and category/warehouse/shipping-method/tax-rate/promotion reads. Links use the returned record UUID, never merchant names/codes, parent IDs or action parameters. Quote links use the quote UUID even when looking it up by order, and never point to cancellation actions. It must be an exact HTTPS origin without a trailing slash, path, query, fragment or credentials; invalid configuration fails startup. Omit it to disable links. This non-secret setting is independent of issuer/resource, is never inferred from requests or merchant data, and must point to the operator's Admin for this shop. No reachability or same-shop check is performed; links require separate Admin login and do not carry tokens or authorize actions. Stdio uses `TERA_ADMIN_ORIGIN` for the same option.
- The OIDC `signingKey` is one private P-256/ES256 JWK with a unique stable `kid`; its public half is served by the provider. Cookie keys are 32-byte base64url strings, newest first, maximum three. Credential keys are 32-byte base64url strings keyed by safe IDs, maximum eight; both processes need the same complete ring and active ID.
- The introspection client ID/secret exactly match between `provider.introspectionClient` and MCP `authorization.introspectionClientId`/`introspectionClientSecret`.
- The host's Supabase service-role key is limited by application code to authorization/credential, connection cleanup, optional audit and high-risk approval RPCs. Approval dispatch can atomically execute only the fixed role/anonymization commands under the bound user identity; ordinary tools use that user's JWT. The key itself remains powerful: isolate the host, configuration and egress, and never expose either configuration file to browsers or MCP clients. The anon key is public, not an admin credential.
- Certificates must be currently valid and cover the configured issuer/resource host; private keys must match. Bind directly to the advertised host/port. Forwarded headers are rejected and proxy TLS termination is unsupported. Use an unprivileged port or a narrowly scoped socket/capability arrangement rather than root.

Human approval is required to create DB roles, apply schema, change public DNS/firewalls/TLS, install or activate secrets, enable writes (`allowWrites`), modify static clients/scopes/redirects, restore data, or promote/rollback a release. Use two-person review for secrets and restore decisions.

## Start, probe, and stop

Start authorization first; only one process may own an issuer database (an advisory lock enforces this). A service manager should use an absolute config path, capture only stdout/stderr, set restart-on-failure with backoff, and allow SIGTERM to drain. Forty seconds is a minimum initial grace budget, not proof that all recovery/cleanup operations finish within it; investigate a drain overrun before forced termination.

```sh
node /opt/tera/dist/auth.mjs /run/tera/oidc.json
bun /opt/tera/mcp/src/remote.ts /run/tera/mcp.json
```

Readiness log lines are exactly `OIDC_SERVICE_READY` and `MCP_HTTP_READY`. They are startup signals, not sufficient health checks. `OIDC_SERVICE_OWNERSHIP_LOST` is fatal; stop/restart under operator control and investigate DB connectivity or a competing instance. Generic `*_START_FAILED`/`*_STOP_FAILED` intentionally omit details.

Personal connection management requires the shop migration `20260923000001_mcp_connection_management.sql` before updating the authorization host and Admin SPA. No issuer schema change is needed. The owning authorization process polls at startup and five seconds after each completed batch, at most 20 revocations per batch, without overlapping polls. It destroys the provider grant family before acknowledging cleanup. Lost acknowledgements are safe to replay. Shutdown/ownership loss stops further scheduling and drains the current operation before closing pools; a crash leaves the persistent intent for the next owner.

Cross-page Admin revocation previews additionally require `20260923000002_mcp_revocation_preview.sql` before publishing the updated SPA. This is a read-only, owner-scoped snapshot capped at 100 eligible records; larger sets fail rather than truncate. Existing explicit-ID revocation and issuer cleanup are unchanged. No issuer upgrade is required for this preview. Production/shared migrations require approval.

`OIDC_CONNECTION_CLEANUP_UNCONFIRMED` means a poll or acknowledgement failed; investigate migration/configuration, downstream availability and issuer storage. No raw errors or identities are logged. Poll failure does not stop the listener or undo the already-committed local revocation. READY does not attest cleanup health. A pending record must not be labelled fully cleaned or deleted to silence the warning. Restoring the shop database can restore old local authorization: coordinate both databases and secrets under the existing restore policy. The queue records personal revocations only; it is not a general reconciliation of expired or client-revoked OAuth grants, and does not delete Supabase Auth sessions.

Approval admission/completion and recovery claims run on the physical ownership session, with PID, backend-start time and lock checked inside each SQL statement. A stale owner cannot admit new approvals through the ordinary pool. Completion is persisted before the resume URL is sent. At restart, pending attempts and completed attempts with an unconsumed Interaction are conservatively revoked; even a browser that received the response but has not resumed must authorize again. Recovery durably claims these attempts before side effects so a concurrent old resume cannot hide unfinished cleanup. This does not fence every Session write or cancel already-dispatched shop operations, and is not multi-node failover support.

The issuer database must support session advisory locks on a dedicated connection; transaction-pooling proxies are unsupported. Reserve that connection in the database budget, and confirm the old process has stopped before takeover. Startup recovery is not a periodic repair worker: unresolved downstream refresh claims require revocation and a new authorization, not automatic claim takeover.

There is no health endpoint. Probe the existing public, fixed endpoints with the deployed CA trust (never `-k`):

```sh
curl --fail --silent --show-error --cacert /etc/ssl/certs/ca-certificates.crt \
  https://auth.example/.well-known/openid-configuration > /dev/null
curl --fail --silent --show-error --cacert /etc/ssl/certs/ca-certificates.crt \
  https://auth.example/jwks > /dev/null
curl --fail --silent --show-error --cacert /etc/ssl/certs/ca-certificates.crt \
  https://shop.example/.well-known/oauth-protected-resource/mcp > /dev/null
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --cacert /etc/ssl/certs/ca-certificates.crt https://shop.example/mcp)" = 401
```

First inspect discovery and use its exact `jwks_uri`; `/jwks` above is the current provider metadata value, not a new endpoint. Assert discovery `issuer`, authorization/token/introspection endpoints, JWKS `kid`/ES256 public fields, and protected-resource `resource`, authorization server, and scopes against the approved manifest. Never send bearer tokens in routine probes. Also monitor certificate expiry, process liveness/restarts, probe latency/status, DB reachability, and Supabase/introspection dependency failures.

Stop MCP first, then authorization, using the service manager's SIGTERM operation. Do not use SIGKILL except incident containment; wait for exit before maintenance. Authorization stops accepting before draining pending work; MCP drains dispatched operations, which may still commit after the client disconnects. Never infer rollback from a timeout or stopped process—reconcile by the operation's idempotency key/state.

## Coordinated secret rotation (offline)

All rotations are maintenance changes: block new traffic, stop MCP, stop authorization, verify both exited, back up as below, replace private config atomically with mode `0600`, then start authorization, probe it, start MCP, and probe it. Never run mixed configurations.

- **Signing key:** only one current key/JWKS entry is supported, so replacement is intentionally disruptive. Replace the JWK and `kid` offline. Existing signed artifacts may no longer verify; invalidate old MCP grants and require fresh authorization. Do not attempt an undocumented two-signing-key overlap.
- **Cookie ring:** prepend one new 32-byte key, retain prior keys only for the bounded cookie lifetime, restart, then in a second approved offline change remove retired keys. Maximum three; never duplicate keys. Emergency compromise rotation removes old keys immediately and forces browser reauthentication.
- **Credential ring:** add a new key ID/material to **both** configurations and make it active in both before restart. Old envelopes remain decryptable only while their referenced key remains. There is no bulk re-encryption maintenance command: do not retire an old key until inventory proves no live credential envelope references it, or invalidate the corresponding MCP grants and require fresh authorization. Never edit envelopes or revisions manually.
- **Introspection secret:** generate one new 32-byte base64url secret and replace it simultaneously in OIDC `provider.introspectionClient.secret` and MCP `authorization.introspectionClientSecret`. Start/probe OIDC before MCP. A one-sided change fails closed but causes outage.

Rotate TLS and Supabase keys with the same stop/atomic-config/start procedure. Supabase key rotation requires coordinated platform action and explicit human approval because rollback may be impossible after revocation.

## Backup and recovery

Back up a coherent set under one change record: (1) a consistent physical/logical backup of the dedicated issuer DB, (2) the corresponding Supabase database backup, and (3) encrypted external material—both private configurations, signing private JWK, full cookie and credential rings, TLS key/cert chain, and secret version metadata. Store DB dumps and keys separately where possible, encrypt at rest, restrict restore access, test integrity, record issuer/resource/project and timestamps, and enforce retention/destruction policy. Never place secrets in repository artifacts or tickets.

Recovery is conservative because the issuer DB contains token/session state while Supabase contains grants, permanent fences/tombstones, and encrypted credentials. Restore only offline to isolated hosts. Verify backup provenance, schema version, issuer/resource/project, external key versions, database timelines, and that no post-backup revocation/role change/credential refresh would be lost. Bring up neither public listener while checking coherence.

If a provably coherent point-in-time restore across issuer DB, Supabase, and required keys cannot be established—including any stale backup—**do not revive authorization state**. With both services offline, run the explicit issuer invalidation command below and require every client to authorize again. It invalidates upstream MCP access/refresh tokens and sessions, not downstream Supabase Auth sessions or shop data. Independently reconcile current administrator roles, compromised credentials, Supabase grants and business data before fresh authorization. Never delete or rewrite grant/fence tables, `oidc.revoked_grants`, credential rows, or approval journal rows with ad hoc SQL. Pending `oidc.approval_attempts` are retained: startup recovers/revokes them before listening and fails closed if cleanup cannot be confirmed.

```sh
# Approved maintenance window only. Same private absolute issuer config as auth.ts.
node /opt/tera/dist/maintenance.mjs invalidate-restored-authorization /run/tera/oidc.json
```

This command takes the exclusive issuer lock and the adapter write lock in the same transaction as invalidation. A live issuer causes refusal; losing the connection rolls back the transaction. It preserves artifact identity/ownership/consumption tombstones, inserts revocation markers for known grant IDs, clears sensitive payload/UID/user-code fields, and preserves every approval journal entry. Success prints only counts; any failure prints `OIDC_MAINTENANCE_FAILED`. Confirm success before startup. It is deliberately disruptive and requires production approval, even if repeat execution is idempotent.

The local rehearsal `bun scripts/mcp-recovery-drill.ts` uses real custom-format `pg_dump` and `pg_restore` in isolated disposable PostgreSQL containers. It demonstrates that a pre-revocation backup restores visible stale artifacts, executes the real maintenance CLI, verifies old access/refresh artifacts and stale writes are rejected, retains pending recovery records, and permits newly created authorization artifacts. This is an **issuer artifact-level drill**, not a coherent full Supabase restore or public token exchange test.

## Sensitive payload maintenance

During an approved offline maintenance window, invoke:

```sh
node /opt/tera/dist/maintenance.mjs cleanup /run/tera/oidc.json 100
```

Each invocation clears at most 100 expired payloads (optional limit 1–1000), retaining permanent tombstones. Repeat bounded invocations while offline until `artifactsCleaned` is zero; each invocation independently requires exclusive issuer ownership. No automatic scheduler or public maintenance endpoint is installed. Records without expiry, live records, grant revocations and approval journals are not purged. Logical scrubbing does not erase historical WAL/backups or reclaim disk immediately: use reviewed PostgreSQL vacuum, encrypted backup retention and storage controls, without deleting safety tombstones. Track artifact/tombstone counts and storage growth; this is not unbounded disk retention solved by TTL.

Both cleanup and restore invalidation mark unresumed completed approvals as pending before scrubbing their Interaction evidence, in the same transaction. They retain the binding for two-sided startup recovery; they do not silently treat payload deletion as confirmation of downstream revocation.

After an approved restore, run startup recovery privately, require clean readiness, verify metadata/JWKS, test unauthorized rejection, then perform a fresh low-privilege authorization and read-only MCP call with a dedicated acceptance identity. Revoke that grant through a supported path and confirm reuse fails before opening traffic.

## Upgrade and rollback

1. Record current revision/artifacts/config hashes (not contents), schemas, secret IDs, and backup coordinates. Review source/config/schema diffs. Ensure the candidate reads all current OIDC artifacts, pending approvals, grant/tombstone versions, credential envelope versions/key IDs, and Supabase RPC contracts.
2. Rehearse on restored, isolated copies. Run the repository checks above plus pending-approval crash/restart and revocation scenarios. Schema changes need explicit forward and rollback plans; never assume code rollback can read a migrated schema.
3. Obtain human approval, drain/stop MCP then OIDC, apply reviewed schema changes as the schema owner, deploy atomically, start/probe OIDC then MCP, and perform read-only acceptance. Keep writes disabled unless separately approved.
4. Roll back only when the old binary/config is compatible with the current schema, artifacts, pending approvals, and key rings. Stop both services first. Never restore a stale DB merely to match old code. If compatibility is uncertain, remain offline and use the conservative recovery policy above.

## Logs, incidents, and public acceptance

Collect service-manager timestamps, process exits and readiness/failure tokens. External probes can record status classes and latency without request bodies. There is no general request log, metric export or distributed correlation platform. Restrict and expire logs. Never log config bodies/paths if revealing, DB URLs, JWK `d`, TLS keys, cookie/credential/introspection keys, Supabase keys, Authorization/cookie headers, tokens, authorization codes, redirect query strings, credential envelopes, provider/database payloads, or full user/grant/binding identifiers. Redact before tickets and incident chat. Debugging must not enable raw provider/SQL/HTTP-body logging in production.

Optional remote `authorization.auditTools: true` enables durable dispatch observations. Default is off; apply the current shop migration sequence before enabling (the audit base is `20260923000003`, resource references are added by `20260924000003`). Each schema-valid, scope-permitted tool call receives a host-generated UUID and a private audit admission before business dispatch. The service-only RPC checks an active bound grant and copies its user/grant/client IDs and deployment binding; headers, arguments and client labels do not select identity. Fixed tool mappings may add a resource type/UUID, but no full arguments, result bodies, credentials or raw errors are stored. Stdio, discovery, invalid inputs and scope/authentication rejections before admission are not audited. An admission can precede a downstream administrator check and does not prove business execution started.

`pending` means no confirmed terminal observation, not failure; `returned` means a validated backend tool result, not business settlement or delivery to the client; `rejected` means the backend reported a definite failure; `unknown` means mutation outcome could not be established. Audit and business transactions are not atomic. Admission receipt loss blocks dispatch (`AUDIT_UNAVAILABLE`), even if a pending row committed. Completion receipt loss returns `AUDIT_COMPLETION_UNCONFIRMED`; successful writes then carry `outcome_unknown: true`, while definitive rejection preserves false. Never automatically replay business operations to repair audit. Completion may follow grant removal and never rewrites an incompatible terminal observation.

`private.mcp_tool_audit` has no direct table privileges even for `service_role`, and no automatic expiry. The constrained security-definer RPC is the host's write path. After migration `20260923000004_my_mcp_tool_calls.sql`, Admin `/connections` uses `list_my_mcp_tool_calls` to show only the current non-anonymous user's safe summary, including after demotion; it cannot select another user or replay/delete a call. Deploy this migration before the updated Admin. An empty list does not prove no activity or that auditing is enabled. These are trusted-host observations, not tamper-proof evidence against a compromised service key/DB owner, nor provenance attached atomically to domain events. Identifiers remain personal data; approve restricted operator access, retention/deletion policy and backup handling before enabling. Grant/account removal intentionally does not cascade into audit deletion. Never copy full identifiers into general logs or incident tickets. Verify locally with `bun run test:current tests/mcp-tool-audit.test.ts tests/mcp-tool-calls.test.ts` and `bun test tests/unit/mcp-tool-audit.test.ts tests/unit/mcp-http.test.ts`.

Both listeners enforce 32 pending operations plus process-local rate budgets: global burst 120/refill 60 per second, direct-peer burst 60/refill 10 per second; MCP additionally uses verified-user burst 30/refill 5 per second before body/credential/business processing. Peer/user maps hold at most 1024 keys; active entries are not evicted to admit new keys. HTTP 429 carries no-store and Retry-After, while concurrency exhaustion returns 503. Node additionally caps all TCP connections at 128, including incomplete TLS handshakes, closing excess sockets. Bun has no corresponding application-level total connection cap. Identity limiting still needs introspection/grant validation; peer limiting never trusts forwarding headers. Restarts reset budgets; NAT users share peer limits. Metadata/probes also consume transport budgets. These are single-instance bounds, not distributed fairness or DDoS protection. A client must not automatically replay writes because Retry-After is present.

Backend JSON streams are capped at 64 KiB for login, authorization, recovery and error receipts, and 8 MiB for business results. Limits count actual bytes, not Content-Length. Oversized responses are rejected and cancelled, never silently truncated; a rejected write response can still mean the mutation committed. Use narrower business queries rather than retrying the same oversized result.

Before any public exposure, humans must approve evidence for: pinned build/check results; dedicated least-privilege DB; coherent backup and restore drill; offline rotation drills for every key class; upgrade/rollback and interrupted-approval drills; valid public DNS and trusted TLS; direct network path with no proxy/forwarded headers; firewall and egress allow-list; static clients/redirect URIs/scopes; `allowWrites` policy; monitoring/alerts/runbook ownership; log redaction/retention; Supabase production migrations/RPC privileges; and a real-browser PKCE, explicit-consent, read-only MCP, revocation, and role-removal acceptance. Record these as **proposed drills/procedures until actually executed in the target environment**—repository tests alone are not production acceptance.
