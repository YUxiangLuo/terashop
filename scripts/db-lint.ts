import { SQL, type TransactionSQL } from 'bun';

interface Issue {
  function: string;
  relation: string | null;
  lineno: number;
  level: string;
  sqlstate: string;
  message: string;
  detail: string | null;
  hint: string | null;
  query: string | null;
}

const canonicalFields = new Map([
  ['private.canonical_variant_quantities(jsonb)', 'variant_id'],
  ['private.canonical_order_item_quantities(jsonb)', 'order_item_id'],
]);

function reviewedJsonWarning(issue: Issue, source: string): boolean {
  const field = canonicalFields.get(issue.function);
  if (!field || issue.level !== 'warning' || issue.sqlstate !== '00000'
      || issue.message !== 'routine is marked as IMMUTABLE, but expression is STABLE') return false;
  // Only this exact UUID/integer aggregation is deterministic despite the generic
  // JSON functions' catalog volatility. New STABLE calls, even in these functions,
  // must fail lint. Match the reported statement, not just the function/message.
  const statement = source.split('\n').slice(issue.lineno - 1).join('\n').split(';')[0];
  const expected = `select jsonb_agg(jsonb_build_object(
    '${field}', x.${field}, 'quantity', x.quantity) order by x.${field})
    into v_result from (
      select (e.value ->> '${field}')::uuid ${field},
             sum((e.value ->> 'quantity')::integer)::integer quantity
      from jsonb_array_elements(p_items) e
      group by (e.value ->> '${field}')::uuid
    ) x`;
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  return normalize(statement) === normalize(expected);
}

function reviewedTriggerBranch(issue: Issue, source: string): boolean {
  // The checker explores both sides of TG_TABLE_NAME guards for each relation.
  // Pin the entire guard and only excuse the field in its unreachable branch;
  // the same statement is checked against the other, matching trigger relation.
  const guards = new Map([
    ['private.assert_checkout_quote_totals()',
      ['checkout_quotes', 'checkout_quote_lines', 'v_quote_id', 'quote_id']],
    ['private.assert_refund_request_lines()',
      ['refund_requests', 'refund_request_lines', 'v_id', 'refund_request_id']],
  ]);
  const guard = guards.get(issue.function);
  if (!guard || issue.level !== 'error' || issue.sqlstate !== '42703') return false;
  const [header, lines, variable, foreignKey] = guard;
  if (issue.relation !== `commerce.${header}` && issue.relation !== `commerce.${lines}`) return false;
  const onHeader = issue.relation === `commerce.${header}`;
  if (issue.message !== `record "new" has no field "${onHeader ? foreignKey : 'id'}"`) return false;
  const start = issue.lineno - 1 - (onHeader ? 3 : 1);
  const block = source.split('\n').slice(start, start + 5).map(line => line.trim()).join('\n');
  return block === [
    `if tg_table_name = '${header}' then`,
    `${variable} := new.id;`,
    'else',
    `${variable} := coalesce(new.${foreignKey}, old.${foreignKey});`,
    'end if;',
  ].join('\n');
}

// Always roll back: neither extension installation nor lint fixtures may survive,
// including when a query, assertion or the checker itself throws.
export async function withRollback<T>(database: SQL, run: (sql: TransactionSQL) => Promise<T>): Promise<T> {
  const rollback = Symbol('lint rollback');
  let result!: T;
  try {
    await database.begin(async sql => { result = await run(sql); throw rollback; });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return result;
}

export async function checkDatabase(sql: TransactionSQL) {
  await sql`create extension if not exists plpgsql_check with schema extensions`;
  const [pricing] = await sql`
    select prosrc from pg_proc
    where oid = 'private.price_checkout(jsonb,jsonb,uuid,text)'::regprocedure
  `;
  // plpgsql_check does not execute runtime DDL. Use the actual function's two
  // CREATE TEMP statements in this same transaction, never a duplicated schema
  // or an invocation of the business function. Fail closed if this shape changes.
  const tables = [...String(pricing.prosrc).matchAll(
    /create\s+temporary\s+table\s+(_price_lines|_price_promos)\s*\([\s\S]*?\)\s+on\s+commit\s+drop\s*;/gi,
  )];
  if (tables.length !== 2 || new Set(tables.map(match => match[1].toLowerCase())).size !== 2) {
    throw new Error('Cannot prepare price_checkout temp tables; review its runtime DDL and lint setup');
  }
  for (const match of tables) await sql.unsafe(match[0]);

  // Check every application PL/pgSQL function, and every distinct attached
  // relation for trigger functions (including triggers on auth.users).
  const targets = await sql`
    select p.oid::regprocedure::text as signature, p.prosrc,
           coalesce(t.tgrelid, 0)::oid as relid,
           case when t.tgrelid is not null then t.tgrelid::regclass::text end as relation,
           t.tgoldtable, t.tgnewtable
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    left join (select distinct tgfoid, tgrelid, tgoldtable, tgnewtable from pg_trigger) t
      on t.tgfoid = p.oid
    where n.nspname in ('public', 'private', 'commerce') and l.lanname = 'plpgsql'
    order by signature, relid
  `;
  const issues: Issue[] = [];
  const reviewed: Issue[] = [];
  for (const target of targets) {
    const diagnostics = await sql`
      select lineno, level, sqlstate, message, detail, hint, query
      from extensions.plpgsql_check_function_tb(
        ${target.signature}::regprocedure, relid => ${target.relid}::oid,
        oldtable => ${target.tgoldtable}::name, newtable => ${target.tgnewtable}::name,
        fatal_errors => false, use_incomment_options => false)
    `;
    for (const diagnostic of diagnostics) {
      const issue = { ...diagnostic, function: target.signature, relation: target.relation } as Issue;
      const known = reviewedJsonWarning(issue, target.prosrc) || reviewedTriggerBranch(issue, target.prosrc);
      (known ? reviewed : issues).push(issue);
    }
  }
  return { checked: targets.length, issues, reviewed };
}

if (import.meta.main) {
  // Deliberately use this project's local Supabase, not an arbitrary DB_URL from
  // the shell. Keep credentials in memory and never echo status output.
  const status = Bun.spawnSync(['bunx', '--no-install', 'supabase', 'status', '-o', 'json']);
  if (status.exitCode !== 0) throw new Error('Local Supabase is unavailable; run bun run start');
  const { DB_URL } = JSON.parse(status.stdout.toString());
  if (typeof DB_URL !== 'string') throw new Error('Local Supabase status did not return DB_URL');
  const database = new SQL(DB_URL, { max: 1 });
  try {
    const report = await withRollback(database, checkDatabase);
    for (const issue of report.issues) console.error(JSON.stringify(issue));
    console.log(`SQL lint: ${report.checked} function/trigger contexts checked; `
      + `${report.issues.length} issues; ${report.reviewed.length} precisely reviewed diagnostics.`);
    // Unlike the CLI's default --fail-on=none, every unreviewed diagnostic fails CI.
    process.exitCode = report.issues.length ? 1 : 0;
  } finally {
    await database.close();
  }
}
