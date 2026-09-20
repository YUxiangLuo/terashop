-- Development baseline: rebuild disposable local databases after schema edits.
-- Supabase supplies auth.users, auth.uid(), auth.role() and its API roles.
-- Schema/constraints first; domain functions next; API permissions last.
begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema private;
create schema commerce;
revoke all on schema private, commerce from public, anon, authenticated, service_role;

-- Never inherit Supabase's broad default grants for newly created objects.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema private
  revoke all on functions from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema commerce
  revoke all on functions from public, anon, authenticated, service_role;

-- Constraint helpers

CREATE FUNCTION private.valid_country_codes(p_countries text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  select coalesce(bool_and(c is not null and c ~ '^[A-Z]{2}$'), true)
  from unnest(p_countries) as x(c);
$_$;

-- Only text attributes participate in commercial identity; never prices or options.
CREATE FUNCTION private.valid_line_attributes(p_attributes jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO ''
    AS $$
  select case when jsonb_typeof(p_attributes) <> 'object' then false else
    octet_length(p_attributes::text) <= 8192
    and (select count(*) <= 20 and coalesce(bool_and(
      length(key) between 1 and 64 and key ~ '[^[:space:]]'
      and jsonb_typeof(value) = 'string' and length(value #>> '{}') <= 500
    ), true) from jsonb_each(p_attributes)) end;
$$;

CREATE FUNCTION private.checkout_line_key(p_variant_id uuid, p_attributes jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO ''
    AS $$
  -- Fixed UUID and JSON text only; independent of quantity, object key order and session settings.
  select encode(extensions.digest(convert_to(p_variant_id::text || ':' || p_attributes::text, 'UTF8'), 'sha256'), 'hex');
$$;

-- A write-conflict sentinel makes category graph validation safe even at REPEATABLE READ.
CREATE TABLE private.category_tree_guard (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), revision bigint NOT NULL DEFAULT 0);
INSERT INTO private.category_tree_guard DEFAULT VALUES;
ALTER TABLE private.category_tree_guard ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.category_tree_guard FROM PUBLIC, anon, authenticated, service_role;

-- Role commands need a row-version conflict, not just an advisory lock.
CREATE TABLE private.role_management_guard (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), revision bigint NOT NULL DEFAULT 0);
INSERT INTO private.role_management_guard DEFAULT VALUES;
ALTER TABLE private.role_management_guard ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.role_management_guard FROM PUBLIC, anon, authenticated, service_role;

-- A key may exist before its optional public definition. Keep a real row
-- version for both writers so REPEATABLE READ cannot validate stale metadata.
CREATE TABLE private.metafield_key_guards (
  owner_type text NOT NULL,
  namespace text NOT NULL,
  key text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (owner_type, namespace, key)
);
ALTER TABLE private.metafield_key_guards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.metafield_key_guards FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.valid_tax_context(p_context jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT SET search_path TO '' AS $$
  select coalesce(jsonb_typeof(p_context) = 'object' and case p_context ->> 'status'
    when 'unrecorded' then p_context = '{"status":"unrecorded"}'::jsonb
    when 'not_calculated' then p_context -> 'destination_country' = 'null'::jsonb and p_context -> 'rule' = 'null'::jsonb
      and p_context ->> 'method' = 'country_rate_variant_line_v1'
    when 'no_rule' then p_context ->> 'destination_country' ~ '^[A-Z]{2}$' and p_context -> 'rule' = 'null'::jsonb
      and p_context ->> 'method' = 'country_rate_variant_line_v1'
    when 'calculated' then p_context ->> 'destination_country' ~ '^[A-Z]{2}$'
      and p_context ->> 'method' = 'country_rate_variant_line_v1'
      and jsonb_typeof(p_context -> 'rule') = 'object'
      and p_context -> 'rule' ->> 'tax_rate_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and jsonb_typeof(p_context -> 'rule' -> 'name') = 'string'
      and p_context -> 'rule' ->> 'country' in (p_context ->> 'destination_country', '*')
      and jsonb_typeof(p_context -> 'rule' -> 'include_shipping') = 'boolean'
      and jsonb_typeof(p_context -> 'rule' -> 'rate') = 'number'
      and (p_context -> 'rule' ->> 'rate')::numeric between 0 and 1
    else false end, false);
$$;

-- Customers are commerce identities, not Auth accounts. Email is contact data,
-- deliberately non-unique and never a credential for claiming historical records.
CREATE TABLE public.customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
    email text CHECK (email IS NULL OR (length(btrim(email)) BETWEEN 1 AND 320)),
    full_name text NOT NULL DEFAULT '' CHECK (length(full_name) <= 200),
    phone text CHECK (phone IS NULL OR length(phone) <= 50),
    anonymized_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (id IS DISTINCT FROM auth_user_id),
    CHECK (anonymized_at IS NULL OR (email IS NULL AND full_name = '' AND phone IS NULL))
);

CREATE FUNCTION private.customer_for_user(p_user_id uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select id from public.customers where auth_user_id = p_user_id and anonymized_at is null;
$$;

CREATE FUNCTION public.current_customer_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  select private.customer_for_user(auth.uid());
$$;

-- Tables: catalog, accounts and transaction facts

CREATE TABLE public.orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_number bigint NOT NULL UNIQUE,
    customer_id uuid NOT NULL,
    email text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    financial_status text DEFAULT 'pending'::text NOT NULL,
    fulfillment_status text DEFAULT 'unfulfilled'::text NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    subtotal numeric(12,2) NOT NULL CONSTRAINT orders_subtotal_finite CHECK (subtotal NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    discount_total numeric(12,2) DEFAULT 0 NOT NULL CONSTRAINT orders_discount_total_finite CHECK (discount_total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    shipping_total numeric(12,2) DEFAULT 0 NOT NULL CONSTRAINT orders_shipping_total_finite CHECK (shipping_total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    tax_total numeric(12,2) DEFAULT 0 NOT NULL CONSTRAINT orders_tax_total_finite CHECK (tax_total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    total numeric(12,2) NOT NULL CONSTRAINT orders_total_finite CHECK (total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    tax_context jsonb DEFAULT '{"status":"unrecorded"}'::jsonb NOT NULL CHECK (private.valid_tax_context(tax_context)),
    shipping_address jsonb NOT NULL,
    billing_address jsonb,
    shipping_method_id uuid,
    shipping_method_name text,
    discount_code text,
    customer_note text,
    admin_note text,
    cancel_reason text,
    cancelled_at timestamp with time zone,
    paid_at timestamp with time zone,
    payment_expires_at timestamp with time zone DEFAULT (now() + interval '15 minutes') NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT orders_payment_expiry_ck CHECK (payment_expires_at > created_at AND payment_expires_at <= created_at + interval '30 minutes'),
    CONSTRAINT orders_currency_usd_chk CHECK (currency = 'USD'),
    CONSTRAINT orders_billing_address_country_chk CHECK (((billing_address IS NULL) OR ((jsonb_typeof(billing_address) = 'object'::text) AND (billing_address ? 'country'::text) AND ((billing_address ->> 'country'::text) ~ '^[A-Z]{2}$'::text))) IS TRUE),
    CONSTRAINT orders_components_nonnegative_chk CHECK (((shipping_total >= (0)::numeric) AND (tax_total >= (0)::numeric))),
    CONSTRAINT orders_discount_range_chk CHECK (((discount_total >= (0)::numeric) AND (discount_total <= subtotal))),
    CONSTRAINT orders_financial_status_check CHECK ((financial_status = ANY (ARRAY['pending'::text, 'paid'::text, 'partially_refunded'::text, 'refunded'::text, 'voided'::text]))),
    CONSTRAINT orders_fulfillment_status_check CHECK ((fulfillment_status = ANY (ARRAY['unfulfilled'::text, 'partially_fulfilled'::text, 'fulfilled'::text]))),
    CONSTRAINT orders_shipping_address_country_chk CHECK (((jsonb_typeof(shipping_address) = 'object'::text) AND (shipping_address ? 'country'::text) AND ((shipping_address ->> 'country'::text) ~ '^[A-Z]{2}$'::text)) IS TRUE),
    CONSTRAINT orders_status_check CHECK ((status = ANY (ARRAY['open'::text, 'completed'::text, 'cancelled'::text]))),
    CONSTRAINT orders_subtotal_check CHECK ((subtotal >= (0)::numeric)),
    CONSTRAINT orders_total_check CHECK ((total >= (0)::numeric)),
    CONSTRAINT orders_total_formula_chk CHECK ((total = round((((subtotal - discount_total) + shipping_total) + tax_total), 2)))
);

CREATE TABLE commerce.checkout_quotes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    pricing_hash text NOT NULL,
    currency text NOT NULL,
    subtotal numeric(12,2) NOT NULL CONSTRAINT checkout_quotes_subtotal_finite CHECK (subtotal NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    discount_total numeric(12,2) DEFAULT 0 NOT NULL CONSTRAINT checkout_quotes_discount_total_finite CHECK (discount_total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    shipping_total numeric(12,2) DEFAULT 0 NOT NULL CONSTRAINT checkout_quotes_shipping_total_finite CHECK (shipping_total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    tax_total numeric(12,2) DEFAULT 0 NOT NULL CONSTRAINT checkout_quotes_tax_total_finite CHECK (tax_total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    total numeric(12,2) NOT NULL CONSTRAINT checkout_quotes_total_finite CHECK (total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    tax_context jsonb DEFAULT '{"status":"unrecorded"}'::jsonb NOT NULL CHECK (private.valid_tax_context(tax_context)),
    shipping_line jsonb CHECK (jsonb_typeof(shipping_line) = 'object'),
    shipping_address jsonb NOT NULL,
    shipping_method_id uuid,
    shipping_method_name text,
    requested_discount_code text,
    customer_note text,
    promotions jsonb DEFAULT '[]'::jsonb NOT NULL,
    order_id uuid,
    cancel_reason text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT checkout_quotes_cancel_reason_check CHECK (((cancel_reason IS NULL) OR (char_length(cancel_reason) <= 500))),
    CONSTRAINT checkout_quotes_check CHECK (((discount_total >= (0)::numeric) AND (discount_total <= subtotal))),
    CONSTRAINT checkout_quotes_check1 CHECK ((round((((subtotal - discount_total) + shipping_total) + tax_total), 2) = total)),
    CONSTRAINT checkout_quotes_check2 CHECK ((expires_at >= (created_at + '00:01:00'::interval))),
    CONSTRAINT checkout_quotes_check3 CHECK ((expires_at <= (created_at + '00:30:00'::interval))),
    CONSTRAINT checkout_quotes_check4 CHECK (((status <> ALL (ARRAY['converted'::text, 'completed'::text])) OR (order_id IS NOT NULL))),
    CONSTRAINT checkout_quotes_check5 CHECK (((status <> 'open'::text) OR (order_id IS NULL))),
    CONSTRAINT checkout_quotes_check6 CHECK (((cancel_reason IS NULL) OR (status = ANY (ARRAY['cancelled'::text, 'expired'::text])))),
    CONSTRAINT checkout_quotes_currency_check CHECK (currency = 'USD'),
    CONSTRAINT checkout_quotes_customer_note_check CHECK (((customer_note IS NULL) OR (char_length(customer_note) <= 2000))),
    CONSTRAINT checkout_quotes_idempotency_key_check CHECK (((length(btrim(idempotency_key)) >= 1) AND (length(btrim(idempotency_key)) <= 200))),
    CONSTRAINT checkout_quotes_pricing_hash_check CHECK ((pricing_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT checkout_quotes_promotions_check CHECK (((jsonb_typeof(promotions) = 'array'::text) AND (pg_column_size(promotions) <= 65536))),
    CONSTRAINT checkout_quotes_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT checkout_quotes_requested_discount_code_check CHECK (((requested_discount_code IS NULL) OR (char_length(requested_discount_code) <= 100))),
    CONSTRAINT checkout_quotes_shipping_address_check CHECK (((jsonb_typeof(shipping_address) = 'object'::text) AND (pg_column_size(shipping_address) <= 16384))),
    CONSTRAINT checkout_quotes_shipping_total_check CHECK ((shipping_total >= (0)::numeric)),
    CONSTRAINT checkout_quotes_status_check CHECK ((status = ANY (ARRAY['open'::text, 'converted'::text, 'completed'::text, 'cancelled'::text, 'expired'::text]))),
    CONSTRAINT checkout_quotes_subtotal_check CHECK ((subtotal >= (0)::numeric)),
    CONSTRAINT checkout_quotes_tax_total_check CHECK ((tax_total >= (0)::numeric)),
    CONSTRAINT checkout_quotes_total_check CHECK ((total >= (0)::numeric))
);

-- Editable intentions only: no price snapshot, stock reservation or customer
-- created for a guest. A guest capability is returned once and stored as a hash.
CREATE TABLE commerce.carts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid REFERENCES public.customers(id) ON DELETE RESTRICT,
    guest_token_hash text CHECK (guest_token_hash ~ '^[0-9a-f]{64}$'),
    idempotency_key text CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','converted','abandoned')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    last_mutation_hash text CHECK (last_mutation_hash ~ '^[0-9a-f]{64}$'),
    address jsonb CHECK (jsonb_typeof(address) = 'object' AND pg_column_size(address) <= 16384),
    shipping_method_id uuid,
    discount_code text CHECK (length(discount_code) <= 100),
    note text CHECK (length(note) <= 2000),
    quote_id uuid UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
    UNIQUE (customer_id, idempotency_key),
    CHECK ((customer_id IS NULL) = (guest_token_hash IS NOT NULL)),
    CHECK (customer_id IS NOT NULL OR idempotency_key IS NULL),
    CHECK ((status = 'converted') = (quote_id IS NOT NULL)),
    CHECK (quote_id IS NULL OR customer_id IS NOT NULL),
    CHECK (status = 'active' OR (address IS NULL AND note IS NULL)),
    CHECK (expires_at >= created_at + interval '1 minute' AND expires_at <= created_at + interval '30 days')
);
CREATE TABLE commerce.cart_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id uuid NOT NULL REFERENCES commerce.carts(id) ON DELETE CASCADE,
    variant_id uuid NOT NULL,
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
    attributes jsonb NOT NULL DEFAULT '{}' CHECK (private.valid_line_attributes(attributes)),
    line_key text GENERATED ALWAYS AS (private.checkout_line_key(variant_id, attributes)) STORED NOT NULL,
    UNIQUE (cart_id, line_key)
);

CREATE TABLE public.fulfillments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    status text DEFAULT 'shipped'::text NOT NULL,
    items jsonb NOT NULL,
    carrier text DEFAULT ''::text NOT NULL,
    tracking_number text DEFAULT ''::text NOT NULL,
    tracking_url text,
    shipped_at timestamp with time zone,
    delivered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fulfillments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'shipped'::text, 'delivered'::text, 'cancelled'::text])))
);

CREATE TABLE commerce.payment_provider_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    provider_event_id text NOT NULL,
    source text NOT NULL,
    event_type text NOT NULL,
    object_reference text,
    livemode boolean NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    payload_hash text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'received'::text NOT NULL,
    outcome text,
    resource_type text,
    resource_id uuid,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_provider_events_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT payment_provider_events_check CHECK (((resource_type IS NULL) = (resource_id IS NULL))),
    CONSTRAINT payment_provider_events_check1 CHECK (((status = ANY (ARRAY['processed'::text, 'ignored'::text])) = (processed_at IS NOT NULL))),
    CONSTRAINT payment_provider_events_data_check CHECK (((jsonb_typeof(data) = 'object'::text) AND (pg_column_size(data) <= 65536))),
    CONSTRAINT payment_provider_events_event_type_check CHECK (((length(btrim(event_type)) >= 1) AND (length(btrim(event_type)) <= 200))),
    CONSTRAINT payment_provider_events_last_error_check CHECK (((last_error IS NULL) OR (char_length(last_error) <= 4000))),
    CONSTRAINT payment_provider_events_object_reference_check CHECK (((object_reference IS NULL) OR ((length(object_reference) >= 1) AND (length(object_reference) <= 255)))),
    CONSTRAINT payment_provider_events_payload_hash_check CHECK ((payload_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT payment_provider_events_provider_check CHECK (provider = 'paypal'),
    CONSTRAINT payment_provider_events_provider_event_id_check CHECK (((length(btrim(provider_event_id)) >= 1) AND (length(btrim(provider_event_id)) <= 255))),
    CONSTRAINT payment_provider_events_resource_type_check CHECK (((resource_type IS NULL) OR (resource_type = ANY (ARRAY['payment_intent'::text, 'payment_transaction'::text, 'refund_request'::text, 'provider_money_movement'::text])))),
    CONSTRAINT payment_provider_events_source_check CHECK ((source = ANY (ARRAY['webhook'::text, 'api_response'::text]))),
    CONSTRAINT payment_provider_events_status_check CHECK ((status = ANY (ARRAY['received'::text, 'processed'::text, 'ignored'::text, 'failed'::text])))
);

CREATE TABLE commerce.payment_intents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    provider text NOT NULL,
    payment_method text DEFAULT 'paypal'::text NOT NULL,
    status text DEFAULT 'requires_action'::text NOT NULL,
    amount numeric(12,2) NOT NULL CONSTRAINT payment_intents_amount_finite CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    currency text NOT NULL,
    idempotency_key text NOT NULL,
    provider_reference text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provider_capture_requested_at timestamp with time zone,
    last_provider_poll_at timestamp with time zone,
    provider_poll_attempts integer DEFAULT 0 NOT NULL CHECK (provider_poll_attempts >= 0),
    CONSTRAINT payment_intents_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT payment_intents_capture_provider_ck CHECK (((provider_capture_requested_at IS NULL) OR (provider = 'paypal'::text))),
    CONSTRAINT payment_intents_currency_check CHECK (currency = 'USD'),
    CONSTRAINT payment_intents_idempotency_key_check CHECK ((length(btrim(idempotency_key)) > 0)),
    CONSTRAINT payment_intents_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT payment_intents_payment_method_check CHECK ((payment_method = ANY (ARRAY['paypal'::text, 'card'::text]))),
    CONSTRAINT payment_intents_payment_method_provider_check CHECK (((payment_method <> 'card'::text) OR (provider = 'paypal'::text))),
    CONSTRAINT payment_intents_provider_check CHECK (provider = 'paypal'),
    CONSTRAINT payment_intents_status_check CHECK ((status = ANY (ARRAY['requires_action'::text, 'processing'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);

CREATE TABLE commerce.provider_money_movements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_event_id uuid NOT NULL,
    provider text NOT NULL,
    kind text NOT NULL,
    provider_reference text NOT NULL,
    amount numeric(20,8) NOT NULL CONSTRAINT provider_money_movements_amount_finite CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    currency text NOT NULL,
    order_id uuid,
    payment_intent_id uuid,
    refund_request_id uuid,
    payment_transaction_id uuid,
    reconciliation_status text DEFAULT 'unmatched'::text NOT NULL,
    last_error text,
    matched_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_money_movements_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT provider_money_movements_check CHECK (((reconciliation_status = 'matched'::text) = (payment_transaction_id IS NOT NULL))),
    CONSTRAINT provider_money_movements_check1 CHECK (((reconciliation_status = 'matched'::text) = (matched_at IS NOT NULL))),
    CONSTRAINT provider_money_movements_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT provider_money_movements_kind_check CHECK ((kind = ANY (ARRAY['capture'::text, 'refund'::text]))),
    CONSTRAINT provider_money_movements_last_error_check CHECK (((last_error IS NULL) OR (char_length(last_error) <= 4000))),
    CONSTRAINT provider_money_movements_provider_check CHECK (provider = 'paypal'),
    CONSTRAINT provider_money_movements_provider_reference_check CHECK (((length(provider_reference) >= 1) AND (length(provider_reference) <= 255))),
    CONSTRAINT provider_money_movements_reconciliation_status_check CHECK ((reconciliation_status = ANY (ARRAY['unmatched'::text, 'matched'::text, 'action_required'::text])))
);

CREATE TABLE commerce.refund_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    parent_transaction_id uuid NOT NULL,
    provider text NOT NULL,
    status text DEFAULT 'requested'::text NOT NULL,
    source text NOT NULL,
    amount numeric(12,2) NOT NULL CONSTRAINT refund_requests_amount_finite CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    currency text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    provider_reference text,
    reason text,
    restock_requested boolean DEFAULT false NOT NULL,
    actor_id uuid,
    result_refund_id uuid,
    failure_code text,
    failure_message text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    submitted_at timestamp with time zone,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provider_refund_requested_at timestamp with time zone,
    last_provider_poll_at timestamp with time zone,
    provider_poll_attempts integer DEFAULT 0 NOT NULL,
    CONSTRAINT refund_requests_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT refund_requests_check CHECK (((status = 'succeeded'::text) = (result_refund_id IS NOT NULL))),
    CONSTRAINT refund_requests_check1 CHECK (((status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text])) = (processed_at IS NOT NULL))),
    CONSTRAINT refund_requests_currency_check CHECK (currency = 'USD'),
    CONSTRAINT refund_requests_failure_code_check CHECK (((failure_code IS NULL) OR (char_length(failure_code) <= 200))),
    CONSTRAINT refund_requests_failure_message_check CHECK (((failure_message IS NULL) OR (char_length(failure_message) <= 2000))),
    CONSTRAINT refund_requests_idempotency_key_check CHECK (((length(btrim(idempotency_key)) >= 1) AND (length(btrim(idempotency_key)) <= 200))),
    CONSTRAINT refund_requests_metadata_check CHECK (((jsonb_typeof(metadata) = 'object'::text) AND (pg_column_size(metadata) <= 16384))),
    CONSTRAINT refund_requests_provider_check CHECK (provider = 'paypal'),
    CONSTRAINT refund_requests_provider_poll_attempts_check CHECK ((provider_poll_attempts >= 0)),
    CONSTRAINT refund_requests_provider_reference_check CHECK (((provider_reference IS NULL) OR ((length(provider_reference) >= 1) AND (length(provider_reference) <= 255)))),
    CONSTRAINT refund_requests_reason_check CHECK (((reason IS NULL) OR (char_length(reason) <= 1000))),
    CONSTRAINT refund_requests_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT refund_requests_source_check CHECK ((source = ANY (ARRAY['items'::text, 'shipping'::text, 'custom_amount'::text, 'remaining'::text]))),
    CONSTRAINT refund_requests_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'submitted'::text, 'processing'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    role text DEFAULT 'customer'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT profiles_role_check CHECK ((role = ANY (ARRAY['customer'::text, 'admin'::text])))
);

CREATE TABLE public.inventory_levels (
    variant_id uuid NOT NULL,
    location_id uuid NOT NULL,
    on_hand integer DEFAULT 0 NOT NULL,
    reservation_revision bigint NOT NULL DEFAULT 0 CHECK (reservation_revision >= 0),
    CONSTRAINT inventory_levels_on_hand_check CHECK ((on_hand >= 0))
);

CREATE TABLE public.product_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    customer_id uuid DEFAULT public.current_customer_id() NOT NULL,
    rating integer NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5))),
    CONSTRAINT product_reviews_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);

CREATE TABLE public.addresses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid DEFAULT public.current_customer_id() NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    recipient_name text NOT NULL CHECK (length(btrim(recipient_name)) > 0),
    phone text,
    country text NOT NULL,
    region text,
    city text,
    line1 text NOT NULL CHECK (length(btrim(line1)) > 0),
    line2 text,
    postal_code text,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT addresses_country_iso_chk CHECK ((country ~ '^[A-Z]{2}$'::text))
);

CREATE TABLE commerce.checkout_quote_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tax_lines jsonb DEFAULT '[]'::jsonb NOT NULL CHECK (jsonb_typeof(tax_lines) = 'array'),
    discount_allocations jsonb DEFAULT '[]'::jsonb NOT NULL CHECK (jsonb_typeof(discount_allocations) = 'array'),
    quote_id uuid NOT NULL,
    variant_id uuid NOT NULL,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL CHECK (private.valid_line_attributes(attributes)),
    line_key text GENERATED ALWAYS AS (private.checkout_line_key(variant_id, attributes)) STORED NOT NULL,
    product_id uuid NOT NULL,
    location_id uuid,
    sku text,
    name text NOT NULL,
    variant_title text DEFAULT ''::text NOT NULL,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    unit_price numeric(12,2) NOT NULL CONSTRAINT checkout_quote_lines_unit_price_finite CHECK (unit_price NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    quantity integer NOT NULL,
    discount_total numeric(12,2) DEFAULT 0 NOT NULL CONSTRAINT checkout_quote_lines_discount_total_finite CHECK (discount_total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    total numeric(12,2) NOT NULL CONSTRAINT checkout_quote_lines_total_finite CHECK (total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    line_total numeric(12,2) NOT NULL CONSTRAINT checkout_quote_lines_line_total_finite CHECK (line_total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    track_inventory boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT checkout_quote_lines_check CHECK ((round((unit_price * (quantity)::numeric), 2) = total)),
    CONSTRAINT checkout_quote_lines_check1 CHECK ((round((total - discount_total), 2) = line_total)),
    CONSTRAINT checkout_quote_lines_check2 CHECK ((discount_total <= total)),
    CONSTRAINT checkout_quote_lines_check3 CHECK (((track_inventory AND (location_id IS NOT NULL)) OR ((NOT track_inventory) AND (location_id IS NULL)))),
    CONSTRAINT checkout_quote_lines_discount_total_check CHECK ((discount_total >= (0)::numeric)),
    CONSTRAINT checkout_quote_lines_line_total_check CHECK ((line_total >= (0)::numeric)),
    CONSTRAINT checkout_quote_lines_options_check CHECK ((jsonb_typeof(options) = 'object'::text)),
    CONSTRAINT checkout_quote_lines_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT checkout_quote_lines_total_check CHECK ((total >= (0)::numeric)),
    CONSTRAINT checkout_quote_lines_unit_price_check CHECK ((unit_price >= (0)::numeric))
);

CREATE TABLE commerce.command_idempotency (
    scope text NOT NULL,
    subject_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT command_idempotency_check CHECK ((((scope = 'order.create'::text) AND (resource_type = 'order'::text)) OR ((scope = 'fulfillment.create'::text) AND (resource_type = 'fulfillment'::text)) OR ((scope = 'order.refund'::text) AND (resource_type = 'refund'::text)))),
    CONSTRAINT command_idempotency_idempotency_key_check CHECK (((length(btrim(idempotency_key)) >= 1) AND (length(btrim(idempotency_key)) <= 200))),
    CONSTRAINT command_idempotency_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT command_idempotency_scope_check CHECK ((scope = ANY (ARRAY['order.create'::text, 'fulfillment.create'::text, 'order.refund'::text])))
);

CREATE TABLE commerce.fulfillment_lines (
    fulfillment_id uuid NOT NULL,
    order_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    quantity integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fulfillment_lines_quantity_check CHECK ((quantity > 0))
);

CREATE TABLE commerce.order_adjustments (
    id bigint NOT NULL,
    order_id uuid NOT NULL,
    order_item_id uuid,
    kind text NOT NULL,
    amount numeric(12,2) NOT NULL CONSTRAINT order_adjustments_amount_finite CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    currency text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    source_type text DEFAULT 'order_snapshot'::text NOT NULL,
    source_ref text,
    idempotency_key text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_adjustments_amount_check CHECK ((amount <> (0)::numeric)),
    CONSTRAINT order_adjustments_currency_check CHECK (currency = 'USD'),
    CONSTRAINT order_adjustments_kind_check CHECK ((kind = ANY (ARRAY['discount'::text, 'shipping'::text, 'tax'::text, 'manual'::text, 'rounding'::text]))),
    CONSTRAINT order_adjustments_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text))
);

CREATE TABLE commerce.outbox_events (
    id bigint NOT NULL,
    event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    idempotency_key text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    retry_start integer DEFAULT 0 NOT NULL CHECK (retry_start BETWEEN 0 AND attempts),
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    published_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outbox_events_lease_ck CHECK (
      (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL AND btrim(locked_by) <> '' AND attempts > 0
       AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > locked_at)
      OR (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL
          AND lease_token IS NULL AND lease_expires_at IS NULL)),
    CONSTRAINT outbox_events_aggregate_type_check CHECK ((length(btrim(aggregate_type)) > 0)),
    CONSTRAINT outbox_events_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT outbox_events_event_type_check CHECK ((length(btrim(event_type)) > 0)),
    CONSTRAINT outbox_events_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT outbox_events_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'published'::text, 'failed'::text, 'exhausted'::text]))),
    CONSTRAINT outbox_events_exhausted_check CHECK (status <> 'exhausted' OR attempts - retry_start >= 25)
);

CREATE TABLE commerce.outbox_redrives (
    event_id uuid NOT NULL,
    attempts integer NOT NULL,
    worker_id text NOT NULL CHECK (length(btrim(worker_id)) BETWEEN 1 AND 200),
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 4000),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, attempts)
);

CREATE TABLE commerce.payment_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    payment_intent_id uuid,
    parent_transaction_id uuid,
    provider text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    amount numeric(12,2) NOT NULL CONSTRAINT payment_transactions_amount_finite CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    currency text NOT NULL,
    provider_reference text,
    idempotency_key text,
    failure_code text,
    failure_message text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_transactions_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT payment_transactions_currency_check CHECK (currency = 'USD'),
    CONSTRAINT payment_transactions_kind_check CHECK ((kind = ANY (ARRAY['authorization'::text, 'capture'::text, 'refund'::text, 'void'::text]))),
    CONSTRAINT payment_transactions_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT payment_transactions_provider_check CHECK ((length(btrim(provider)) > 0)),
    CONSTRAINT payment_transactions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);

CREATE TABLE commerce.refund_lines (
    refund_id uuid NOT NULL,
    order_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    quantity integer NOT NULL,
    amount numeric(12,2) NOT NULL CONSTRAINT refund_lines_amount_finite CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    restocked_quantity integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cancelled_quantity integer DEFAULT 0 NOT NULL,
    CONSTRAINT refund_lines_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT refund_lines_check CHECK (restocked_quantity >= 0 AND restocked_quantity <= cancelled_quantity),
    CONSTRAINT refund_lines_check1 CHECK (((cancelled_quantity >= 0) AND (cancelled_quantity <= quantity))),
    CONSTRAINT refund_lines_quantity_check CHECK ((quantity > 0))
);

CREATE TABLE commerce.refund_request_lines (
    refund_request_id uuid NOT NULL,
    order_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    quantity integer NOT NULL,
    amount numeric(12,2) NOT NULL CONSTRAINT refund_request_lines_amount_finite CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cancelled_quantity integer DEFAULT 0 NOT NULL,
    CONSTRAINT refund_request_lines_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT refund_request_lines_check CHECK (((cancelled_quantity >= 0) AND (cancelled_quantity <= quantity))),
    CONSTRAINT refund_request_lines_quantity_check CHECK ((quantity > 0))
);

CREATE TABLE commerce.refunds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    payment_transaction_id uuid,
    status text NOT NULL,
    source text NOT NULL,
    amount numeric(12,2) NOT NULL CONSTRAINT refunds_amount_finite CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    currency text NOT NULL,
    reason text,
    restock_requested boolean DEFAULT false NOT NULL,
    actor_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT refunds_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT refunds_currency_check CHECK (currency = 'USD'),
    CONSTRAINT refunds_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT refunds_source_check CHECK ((source = ANY (ARRAY['items'::text, 'shipping'::text, 'custom_amount'::text, 'remaining'::text, 'legacy'::text]))),
    CONSTRAINT refunds_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);

CREATE TABLE public.categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    parent_id uuid,
    image_url text,
    "position" integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT categories_no_self_parent CHECK (((parent_id IS NULL) OR (parent_id <> id)))
);

CREATE TABLE public.discount_redemptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    promotion_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    order_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.inventory_movements (
    id bigint NOT NULL,
    variant_id uuid NOT NULL,
    location_id uuid NOT NULL,
    delta integer NOT NULL,
    on_hand_after integer NOT NULL,
    reason text NOT NULL,
    order_id uuid,
    actor_id uuid,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inventory_movements_reason_check CHECK ((reason = ANY (ARRAY['order'::text, 'cancel'::text, 'restock'::text, 'adjust'::text, 'return'::text])))
);

CREATE TABLE public.locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    address jsonb,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.metafield_definitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_type text NOT NULL,
    namespace text DEFAULT 'custom'::text NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    access text DEFAULT 'admin' NOT NULL CHECK (access IN ('admin', 'public', 'customer')),
    CONSTRAINT metafield_definitions_access_owner_check CHECK (
      access = 'admin' OR (access = 'public' AND owner_type IN ('product','variant','category','shop'))
      OR (access = 'customer' AND owner_type IN ('customer','order'))),
    description text DEFAULT ''::text NOT NULL,
    validations jsonb DEFAULT '{}'::jsonb NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT metafield_definitions_owner_type_check CHECK ((owner_type = ANY (ARRAY['product'::text, 'variant'::text, 'category'::text, 'customer'::text, 'order'::text, 'shop'::text]))),
    CONSTRAINT metafield_definitions_type_check CHECK ((type = ANY (ARRAY['text'::text, 'rich_text'::text, 'number'::text, 'boolean'::text, 'date'::text, 'datetime'::text, 'url'::text, 'color'::text, 'json'::text, 'list_text'::text, 'list_number'::text, 'metaobject_reference'::text, 'list_metaobject_reference'::text])))
);

CREATE TABLE public.metafields (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_type text NOT NULL,
    owner_id uuid NOT NULL,
    -- Derived FK routing, never client-supplied identities. Real RI also protects
    -- concurrent deletes and old snapshots; an EXISTS trigger alone cannot.
    owner_product_id uuid GENERATED ALWAYS AS (case when owner_type = 'product' then owner_id end) STORED,
    owner_variant_id uuid GENERATED ALWAYS AS (case when owner_type = 'variant' then owner_id end) STORED,
    owner_category_id uuid GENERATED ALWAYS AS (case when owner_type = 'category' then owner_id end) STORED,
    owner_customer_id uuid GENERATED ALWAYS AS (case when owner_type = 'customer' then owner_id end) STORED,
    owner_order_id uuid GENERATED ALWAYS AS (case when owner_type = 'order' then owner_id end) STORED,
    namespace text DEFAULT 'custom'::text NOT NULL,
    key text NOT NULL,
    type text NOT NULL,
    value jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT metafields_type_check CHECK (type IN ('text','rich_text','number','boolean','date','datetime','url','color','json','list_text','list_number','metaobject_reference','list_metaobject_reference')),
    CONSTRAINT metafields_owner_type_check CHECK ((owner_type = ANY (ARRAY['product'::text, 'variant'::text, 'category'::text, 'customer'::text, 'order'::text, 'shop'::text])))
);

CREATE TABLE public.metaobject_definitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    fields jsonb NOT NULL,
    access text DEFAULT 'admin' NOT NULL CHECK (access IN ('admin', 'public')),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.metaobjects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    definition_id uuid NOT NULL,
    handle text NOT NULL,
    "values" jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT metaobjects_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text])))
);

CREATE TABLE public.order_events (
    id bigint NOT NULL,
    order_id uuid NOT NULL,
    actor_id uuid,
    type text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    variant_id uuid,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL CHECK (private.valid_line_attributes(attributes)),
    line_key text GENERATED ALWAYS AS (private.checkout_line_key(coalesce(variant_id, id), attributes)) STORED NOT NULL,
    product_id uuid,
    sku text,
    name text NOT NULL,
    variant_title text DEFAULT ''::text NOT NULL,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    unit_price numeric(12,2) NOT NULL CONSTRAINT order_items_unit_price_finite CHECK (unit_price NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    quantity integer NOT NULL,
    total numeric(12,2) NOT NULL CONSTRAINT order_items_total_finite CHECK (total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    discount_total numeric(12,2) DEFAULT 0 NOT NULL CONSTRAINT order_items_discount_total_finite CHECK (discount_total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    line_total numeric(12,2) GENERATED ALWAYS AS (round(((unit_price * (quantity)::numeric) - discount_total), 2)) STORED CONSTRAINT order_items_line_total_finite CHECK (line_total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    refunded_quantity integer DEFAULT 0 NOT NULL,
    refunded_amount numeric(12,2) DEFAULT 0 NOT NULL CONSTRAINT order_items_refunded_amount_finite CHECK (refunded_amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    CONSTRAINT order_items_check CHECK (((refunded_quantity >= 0) AND (refunded_quantity <= quantity))),
    CONSTRAINT order_items_check1 CHECK (((refunded_amount >= (0)::numeric) AND (refunded_amount <= (unit_price * (quantity)::numeric)))),
    CONSTRAINT order_items_discount_within_line CHECK (((discount_total >= (0)::numeric) AND (discount_total <= (unit_price * (quantity)::numeric)))),
    CONSTRAINT order_items_line_total_nonneg CHECK ((line_total >= (0)::numeric)),
    CONSTRAINT order_items_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT order_items_refunded_amount_within_net_chk CHECK ((refunded_amount <= line_total)),
    CONSTRAINT order_items_total_check CHECK (total = round(unit_price * quantity, 2)),
    CONSTRAINT order_items_total_nonnegative_check CHECK (total >= 0),
    CONSTRAINT order_items_unit_price_check CHECK ((unit_price >= (0)::numeric))
);

CREATE TABLE public.order_promotions (
    snapshot jsonb DEFAULT '{}'::jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    order_id uuid NOT NULL,
    promotion_id uuid NOT NULL,
    name text NOT NULL,
    code text,
    amount numeric(12,2) NOT NULL CONSTRAINT order_promotions_amount_finite CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.product_categories (
    product_id uuid NOT NULL,
    category_id uuid NOT NULL
);

CREATE TABLE public.product_images (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    variant_id uuid,
    url text NOT NULL,
    alt text DEFAULT ''::text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.product_variants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    sku text,
    barcode text,
    price numeric(12,2) NOT NULL CONSTRAINT product_variants_price_finite CHECK (price NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    compare_at_price numeric(12,2) CONSTRAINT product_variants_compare_at_price_finite CHECK (compare_at_price NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    cost numeric(12,2) CONSTRAINT product_variants_cost_finite CHECK (cost NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    track_inventory boolean DEFAULT true NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_variants_check CHECK (((compare_at_price IS NULL) OR (compare_at_price >= price))),
    CONSTRAINT product_variants_price_check CHECK ((price >= (0)::numeric))
);

CREATE TABLE public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    revision bigint DEFAULT 1 NOT NULL CHECK (revision > 0),
    slug text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    vendor text DEFAULT ''::text NOT NULL,
    product_type text DEFAULT ''::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    seo_title text,
    seo_description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT products_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])))
);

CREATE TABLE public.product_option_values (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    option_id uuid NOT NULL,
    value text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.product_options (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    name text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.promotion_targets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    promotion_id uuid NOT NULL,
    role text DEFAULT 'apply'::text NOT NULL,
    product_id uuid,
    category_id uuid,
    variant_id uuid,
    CONSTRAINT promotion_targets_check CHECK ((num_nonnulls(product_id, category_id, variant_id) = 1)),
    CONSTRAINT promotion_targets_role_check CHECK ((role = ANY (ARRAY['apply'::text, 'get'::text])))
);

CREATE TABLE public.promotions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    code text,
    type text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    stackable boolean DEFAULT false NOT NULL,
    apply_scope text NOT NULL DEFAULT 'all' CHECK (apply_scope IN ('all','selected')),
    get_scope text NOT NULL DEFAULT 'same_as_apply' CHECK (get_scope IN ('same_as_apply','selected')),
    usage_limit integer,
    used_count integer DEFAULT 0 NOT NULL,
    per_customer_limit integer DEFAULT 1 NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT promotions_code_nonempty_chk CHECK (((code IS NULL) OR (length(btrim(code)) > 0))),
    CONSTRAINT promotions_code_upper_chk CHECK (((code IS NULL) OR (code = upper(code)))),
    CONSTRAINT promotions_per_customer_limit_positive_chk CHECK ((per_customer_limit > 0)),
    CONSTRAINT promotions_schedule_chk CHECK (((starts_at IS NULL) OR (ends_at IS NULL) OR (starts_at <= ends_at))),
    CONSTRAINT promotions_type_check CHECK ((type = ANY (ARRAY['order_percentage'::text, 'order_fixed'::text, 'item_percentage'::text, 'buy_x_get_y'::text, 'free_shipping'::text]))),
    CONSTRAINT promotions_usage_limit_positive_chk CHECK (((usage_limit IS NULL) OR (usage_limit > 0))),
    CONSTRAINT promotions_used_count_nonnegative_chk CHECK ((used_count >= 0)),
    CONSTRAINT promotions_used_within_limit_chk CHECK (((usage_limit IS NULL) OR (used_count <= usage_limit)))
);

CREATE TABLE public.shipping_methods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    countries text[] DEFAULT '{}'::text[] NOT NULL,
    price numeric(12,2) DEFAULT 0 NOT NULL CONSTRAINT shipping_methods_price_finite CHECK (price NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    free_above numeric(12,2) CONSTRAINT shipping_methods_free_above_finite CHECK (free_above NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    estimated_days text DEFAULT ''::text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shipping_methods_countries_iso_chk CHECK (private.valid_country_codes(countries)),
    CONSTRAINT shipping_methods_price_check CHECK ((price >= (0)::numeric))
);

CREATE TABLE public.tax_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    country text DEFAULT '*'::text NOT NULL,
    rate numeric(5,4) NOT NULL CONSTRAINT tax_rates_rate_finite CHECK (rate NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    include_shipping boolean DEFAULT false NOT NULL,
    CONSTRAINT tax_rates_country_iso_chk CHECK (((country = '*'::text) OR (country ~ '^[A-Z]{2}$'::text))),
    CONSTRAINT tax_rates_rate_check CHECK ((rate >= (0)::numeric)),
    CONSTRAINT tax_rates_rate_range_chk CHECK (((rate >= (0)::numeric) AND (rate <= (1)::numeric)))
);

CREATE TABLE public.variant_option_values (
    variant_id uuid NOT NULL,
    option_value_id uuid NOT NULL
);

-- Durable price facts; Quote keeps a hashed offer snapshot instead of a second ledger.
CREATE TABLE commerce.order_shipping_lines (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    order_id uuid NOT NULL UNIQUE,
    shipping_method_id uuid,
    name text NOT NULL,
    gross_amount numeric(12,2) NOT NULL CHECK (gross_amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND gross_amount >= 0),
    discount_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND discount_total >= 0),
    threshold_discount numeric(12,2) NOT NULL DEFAULT 0 CHECK (threshold_discount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND threshold_discount >= 0),
    total numeric(12,2) GENERATED ALWAYS AS (gross_amount - discount_total) STORED CHECK (total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    policy jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(policy) = 'object'),
    UNIQUE (id, order_id),
    CHECK (threshold_discount <= discount_total AND discount_total <= gross_amount)
);
CREATE TABLE commerce.order_tax_lines (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    order_id uuid NOT NULL,
    order_item_id uuid,
    shipping_line_id uuid,
    tax_rate_id uuid NOT NULL,
    name text NOT NULL,
    country text NOT NULL CHECK (country = '*' OR country ~ '^[A-Z]{2}$'),
    rate numeric(5,4) NOT NULL CHECK (rate NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND rate BETWEEN 0 AND 1),
    taxable_amount numeric(12,2) NOT NULL CHECK (taxable_amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND taxable_amount >= 0),
    amount numeric(12,2) NOT NULL CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND amount >= 0),
    UNIQUE (id, order_id),
    UNIQUE NULLS NOT DISTINCT (order_id, order_item_id, shipping_line_id, tax_rate_id),
    CHECK (num_nonnulls(order_item_id, shipping_line_id) = 1),
    CHECK (amount BETWEEN floor(taxable_amount * rate * 100) / 100 AND ceil(taxable_amount * rate * 100) / 100)
);
CREATE TABLE commerce.order_discount_allocations (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    order_id uuid NOT NULL,
    order_item_id uuid,
    shipping_line_id uuid,
    promotion_id uuid,
    label text NOT NULL CHECK (length(btrim(label)) > 0),
    amount numeric(12,2) NOT NULL CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND amount > 0),
    UNIQUE NULLS NOT DISTINCT (order_id, order_item_id, shipping_line_id, promotion_id),
    CHECK (num_nonnulls(order_item_id, shipping_line_id) = 1)
);
-- Merchandise net refunds already live in refund[_request]_lines.amount.
-- These additional components explain tax, shipping and explicitly unallocated money.
CREATE TABLE commerce.refund_components (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    refund_id uuid NOT NULL,
    order_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('tax', 'shipping', 'unallocated')),
    tax_line_id uuid,
    shipping_line_id uuid,
    amount numeric(12,2) NOT NULL CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND amount > 0),
    UNIQUE NULLS NOT DISTINCT (refund_id, kind, tax_line_id, shipping_line_id),
    CHECK ((kind = 'tax' AND tax_line_id IS NOT NULL AND shipping_line_id IS NULL)
        OR (kind = 'shipping' AND shipping_line_id IS NOT NULL AND tax_line_id IS NULL)
        OR (kind = 'unallocated' AND tax_line_id IS NULL AND shipping_line_id IS NULL))
);
CREATE TABLE commerce.refund_request_components (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    refund_request_id uuid NOT NULL,
    order_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('tax', 'shipping', 'unallocated')),
    tax_line_id uuid,
    shipping_line_id uuid,
    amount numeric(12,2) NOT NULL CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND amount > 0),
    UNIQUE NULLS NOT DISTINCT (refund_request_id, kind, tax_line_id, shipping_line_id),
    CHECK ((kind = 'tax' AND tax_line_id IS NOT NULL AND shipping_line_id IS NULL)
        OR (kind = 'shipping' AND shipping_line_id IS NOT NULL AND tax_line_id IS NULL)
        OR (kind = 'unallocated' AND tax_line_id IS NULL AND shipping_line_id IS NULL))
);

-- Identity sequences, keys and foreign keys

ALTER TABLE commerce.checkout_quotes ADD UNIQUE (id, customer_id);
ALTER TABLE commerce.carts ADD FOREIGN KEY (quote_id, customer_id) REFERENCES commerce.checkout_quotes(id, customer_id);
CREATE INDEX carts_customer_active_idx ON commerce.carts(customer_id) WHERE status = 'active';
CREATE INDEX carts_expiry_idx ON commerce.carts(expires_at, id);

ALTER TABLE commerce.order_adjustments ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME commerce.order_adjustments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE commerce.outbox_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME commerce.outbox_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.inventory_movements ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.inventory_movements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.order_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.order_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE public.orders ALTER COLUMN order_number ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.orders_order_number_seq
    START WITH 1001
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY commerce.checkout_quote_lines
    ADD CONSTRAINT checkout_quote_lines_pkey PRIMARY KEY (id);

ALTER TABLE ONLY commerce.checkout_quote_lines
    ADD CONSTRAINT checkout_quote_lines_quote_line_key UNIQUE (quote_id, line_key);

ALTER TABLE ONLY commerce.checkout_quotes
    ADD CONSTRAINT checkout_quotes_customer_id_idempotency_key_key UNIQUE (customer_id, idempotency_key);

ALTER TABLE ONLY commerce.checkout_quotes
    ADD CONSTRAINT checkout_quotes_order_id_key UNIQUE (order_id);

ALTER TABLE ONLY commerce.checkout_quotes
    ADD CONSTRAINT checkout_quotes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY commerce.command_idempotency
    ADD CONSTRAINT command_idempotency_pkey PRIMARY KEY (scope, subject_id, idempotency_key);

ALTER TABLE ONLY commerce.fulfillment_lines
    ADD CONSTRAINT fulfillment_lines_pkey PRIMARY KEY (fulfillment_id, order_item_id);

ALTER TABLE ONLY commerce.order_adjustments
    ADD CONSTRAINT order_adjustments_idempotency_key_key UNIQUE (idempotency_key);

ALTER TABLE ONLY commerce.order_adjustments
    ADD CONSTRAINT order_adjustments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY commerce.outbox_events
    ADD CONSTRAINT outbox_events_event_id_key UNIQUE (event_id);

ALTER TABLE ONLY commerce.outbox_events
    ADD CONSTRAINT outbox_events_idempotency_key_key UNIQUE (idempotency_key);

ALTER TABLE ONLY commerce.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY commerce.payment_intents
    ADD CONSTRAINT payment_intents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY commerce.payment_intents
    ADD CONSTRAINT payment_intents_order_provider_idempotency_key_key UNIQUE (order_id, provider, idempotency_key);

ALTER TABLE ONLY commerce.payment_provider_events
    ADD CONSTRAINT payment_provider_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY commerce.payment_provider_events
    ADD CONSTRAINT payment_provider_events_provider_provider_event_id_key UNIQUE (provider, provider_event_id);

ALTER TABLE ONLY commerce.payment_transactions
    ADD CONSTRAINT payment_transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY commerce.provider_money_movements
    ADD CONSTRAINT provider_money_movements_payment_transaction_id_key UNIQUE (payment_transaction_id);

ALTER TABLE ONLY commerce.provider_money_movements
    ADD CONSTRAINT provider_money_movements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY commerce.provider_money_movements
    ADD CONSTRAINT provider_money_movements_provider_event_id_key UNIQUE (provider_event_id);

ALTER TABLE ONLY commerce.provider_money_movements
    ADD CONSTRAINT provider_money_movements_provider_kind_provider_reference_key UNIQUE (provider, kind, provider_reference);

ALTER TABLE ONLY commerce.refund_lines
    ADD CONSTRAINT refund_lines_pkey PRIMARY KEY (refund_id, order_item_id);

ALTER TABLE ONLY commerce.refund_request_lines
    ADD CONSTRAINT refund_request_lines_pkey PRIMARY KEY (refund_request_id, order_item_id);

ALTER TABLE ONLY commerce.refund_requests
    ADD CONSTRAINT refund_requests_id_order_id_key UNIQUE (id, order_id);

ALTER TABLE ONLY commerce.refund_requests
    ADD CONSTRAINT refund_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY commerce.refund_requests
    ADD CONSTRAINT refund_requests_provider_idempotency_key_key UNIQUE (provider, idempotency_key);

ALTER TABLE ONLY commerce.refund_requests
    ADD CONSTRAINT refund_requests_result_refund_id_key UNIQUE (result_refund_id);

ALTER TABLE ONLY commerce.refunds
    ADD CONSTRAINT refunds_id_order_id_key UNIQUE (id, order_id);

ALTER TABLE ONLY commerce.refunds
    ADD CONSTRAINT refunds_payment_transaction_id_key UNIQUE (payment_transaction_id);

ALTER TABLE ONLY commerce.refunds
    ADD CONSTRAINT refunds_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.addresses
    ADD CONSTRAINT addresses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_slug_key UNIQUE (slug);

ALTER TABLE ONLY public.discount_redemptions
    ADD CONSTRAINT discount_redemptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fulfillments
    ADD CONSTRAINT fulfillments_id_order_uk UNIQUE (id, order_id);

ALTER TABLE ONLY public.fulfillments
    ADD CONSTRAINT fulfillments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.inventory_levels
    ADD CONSTRAINT inventory_levels_pkey PRIMARY KEY (variant_id, location_id);

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_code_key UNIQUE (code);

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.metafield_definitions
    ADD CONSTRAINT metafield_definitions_owner_type_namespace_key_key UNIQUE (owner_type, namespace, key);

ALTER TABLE ONLY public.metafield_definitions
    ADD CONSTRAINT metafield_definitions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.metafields
    ADD CONSTRAINT metafields_owner_type_owner_id_namespace_key_key UNIQUE (owner_type, owner_id, namespace, key);

ALTER TABLE ONLY public.metafields
    ADD CONSTRAINT metafields_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.metaobject_definitions
    ADD CONSTRAINT metaobject_definitions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.metaobject_definitions
    ADD CONSTRAINT metaobject_definitions_type_key UNIQUE (type);

ALTER TABLE ONLY public.metaobjects
    ADD CONSTRAINT metaobjects_definition_id_handle_key UNIQUE (definition_id, handle);

ALTER TABLE ONLY public.metaobjects
    ADD CONSTRAINT metaobjects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_id_order_uk UNIQUE (id, order_id);

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_line_key UNIQUE (order_id, line_key);

ALTER TABLE ONLY public.order_promotions
    ADD CONSTRAINT order_promotions_pkey PRIMARY KEY (order_id, promotion_id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.product_categories
    ADD CONSTRAINT product_categories_pkey PRIMARY KEY (product_id, category_id);

ALTER TABLE ONLY public.product_images
    ADD CONSTRAINT product_images_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.product_option_values
    ADD CONSTRAINT product_option_values_option_id_value_key UNIQUE (option_id, value);

ALTER TABLE ONLY public.product_option_values
    ADD CONSTRAINT product_option_values_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.product_options
    ADD CONSTRAINT product_options_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.product_options
    ADD CONSTRAINT product_options_product_id_name_key UNIQUE (product_id, name);

ALTER TABLE ONLY public.product_reviews
    ADD CONSTRAINT product_reviews_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.product_reviews
    ADD CONSTRAINT product_reviews_product_id_customer_id_key UNIQUE (product_id, customer_id);

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_sku_key UNIQUE (sku);

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_slug_key UNIQUE (slug);

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.promotion_targets
    ADD CONSTRAINT promotion_targets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.promotions
    ADD CONSTRAINT promotions_code_key UNIQUE (code);

ALTER TABLE ONLY public.promotions
    ADD CONSTRAINT promotions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.shipping_methods
    ADD CONSTRAINT shipping_methods_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tax_rates
    ADD CONSTRAINT tax_rates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.variant_option_values
    ADD CONSTRAINT variant_option_values_pkey PRIMARY KEY (variant_id, option_value_id);

ALTER TABLE ONLY commerce.checkout_quote_lines
    ADD CONSTRAINT checkout_quote_lines_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.checkout_quote_lines
    ADD CONSTRAINT checkout_quote_lines_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.checkout_quote_lines
    ADD CONSTRAINT checkout_quote_lines_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES commerce.checkout_quotes(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.checkout_quote_lines
    ADD CONSTRAINT checkout_quote_lines_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.checkout_quotes
    ADD CONSTRAINT checkout_quotes_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.checkout_quotes
    ADD CONSTRAINT checkout_quotes_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.checkout_quotes
    ADD CONSTRAINT checkout_quotes_shipping_method_id_fkey FOREIGN KEY (shipping_method_id) REFERENCES public.shipping_methods(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.fulfillment_lines
    ADD CONSTRAINT fulfillment_lines_fulfillment_id_order_id_fkey FOREIGN KEY (fulfillment_id, order_id) REFERENCES public.fulfillments(id, order_id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.fulfillment_lines
    ADD CONSTRAINT fulfillment_lines_order_item_id_order_id_fkey FOREIGN KEY (order_item_id, order_id) REFERENCES public.order_items(id, order_id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.order_adjustments
    ADD CONSTRAINT order_adjustments_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY commerce.order_adjustments
    ADD CONSTRAINT order_adjustments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.order_adjustments
    ADD CONSTRAINT order_adjustments_order_item_id_order_id_fkey FOREIGN KEY (order_item_id, order_id) REFERENCES public.order_items(id, order_id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.payment_intents
    ADD CONSTRAINT payment_intents_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.payment_transactions
    ADD CONSTRAINT payment_transactions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.payment_transactions
    ADD CONSTRAINT payment_transactions_parent_transaction_id_fkey FOREIGN KEY (parent_transaction_id) REFERENCES commerce.payment_transactions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.payment_transactions
    ADD CONSTRAINT payment_transactions_payment_intent_id_fkey FOREIGN KEY (payment_intent_id) REFERENCES commerce.payment_intents(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.provider_money_movements
    ADD CONSTRAINT provider_money_movements_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.provider_money_movements
    ADD CONSTRAINT provider_money_movements_payment_intent_id_fkey FOREIGN KEY (payment_intent_id) REFERENCES commerce.payment_intents(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.provider_money_movements
    ADD CONSTRAINT provider_money_movements_payment_transaction_id_fkey FOREIGN KEY (payment_transaction_id) REFERENCES commerce.payment_transactions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.provider_money_movements
    ADD CONSTRAINT provider_money_movements_provider_event_id_fkey FOREIGN KEY (provider_event_id) REFERENCES commerce.payment_provider_events(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.provider_money_movements
    ADD CONSTRAINT provider_money_movements_refund_request_fk FOREIGN KEY (refund_request_id) REFERENCES commerce.refund_requests(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.refund_lines
    ADD CONSTRAINT refund_lines_order_item_id_order_id_fkey FOREIGN KEY (order_item_id, order_id) REFERENCES public.order_items(id, order_id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.refund_lines
    ADD CONSTRAINT refund_lines_refund_id_order_id_fkey FOREIGN KEY (refund_id, order_id) REFERENCES commerce.refunds(id, order_id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.refund_request_lines
    ADD CONSTRAINT refund_request_lines_order_item_id_order_id_fkey FOREIGN KEY (order_item_id, order_id) REFERENCES public.order_items(id, order_id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.refund_request_lines
    ADD CONSTRAINT refund_request_lines_refund_request_id_order_id_fkey FOREIGN KEY (refund_request_id, order_id) REFERENCES commerce.refund_requests(id, order_id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.refund_requests
    ADD CONSTRAINT refund_requests_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY commerce.refund_requests
    ADD CONSTRAINT refund_requests_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.refund_requests
    ADD CONSTRAINT refund_requests_parent_transaction_id_fkey FOREIGN KEY (parent_transaction_id) REFERENCES commerce.payment_transactions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.refund_requests
    ADD CONSTRAINT refund_requests_result_refund_id_fkey FOREIGN KEY (result_refund_id) REFERENCES commerce.refunds(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.refunds
    ADD CONSTRAINT refunds_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY commerce.refunds
    ADD CONSTRAINT refunds_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT;

ALTER TABLE ONLY commerce.refunds
    ADD CONSTRAINT refunds_payment_transaction_id_fkey FOREIGN KEY (payment_transaction_id) REFERENCES commerce.payment_transactions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.addresses
    ADD CONSTRAINT addresses_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.categories(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.discount_redemptions
    ADD CONSTRAINT discount_redemptions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);

ALTER TABLE ONLY public.discount_redemptions
    ADD CONSTRAINT discount_redemptions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);

ALTER TABLE ONLY public.discount_redemptions
    ADD CONSTRAINT discount_redemptions_promotion_id_fkey FOREIGN KEY (promotion_id) REFERENCES public.promotions(id);

ALTER TABLE ONLY public.fulfillments
    ADD CONSTRAINT fulfillments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.inventory_levels
    ADD CONSTRAINT inventory_levels_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.inventory_levels
    ADD CONSTRAINT inventory_levels_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.locations(id);

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id);

ALTER TABLE ONLY public.metaobjects
    ADD CONSTRAINT metaobjects_definition_id_fkey FOREIGN KEY (definition_id) REFERENCES public.metaobject_definitions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id);

ALTER TABLE ONLY public.order_promotions
    ADD CONSTRAINT order_promotions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.order_promotions
    ADD CONSTRAINT order_promotions_promotion_id_fkey FOREIGN KEY (promotion_id) REFERENCES public.promotions(id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_shipping_method_id_fkey FOREIGN KEY (shipping_method_id) REFERENCES public.shipping_methods(id);

ALTER TABLE ONLY public.product_categories
    ADD CONSTRAINT product_categories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.product_categories
    ADD CONSTRAINT product_categories_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.product_images
    ADD CONSTRAINT product_images_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.product_images
    ADD CONSTRAINT product_images_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.product_option_values
    ADD CONSTRAINT product_option_values_option_id_fkey FOREIGN KEY (option_id) REFERENCES public.product_options(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.product_options
    ADD CONSTRAINT product_options_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.product_reviews
    ADD CONSTRAINT product_reviews_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.product_reviews
    ADD CONSTRAINT product_reviews_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.promotion_targets
    ADD CONSTRAINT promotion_targets_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.promotion_targets
    ADD CONSTRAINT promotion_targets_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.promotion_targets
    ADD CONSTRAINT promotion_targets_promotion_id_fkey FOREIGN KEY (promotion_id) REFERENCES public.promotions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.promotion_targets
    ADD CONSTRAINT promotion_targets_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.variant_option_values
    ADD CONSTRAINT variant_option_values_option_value_id_fkey FOREIGN KEY (option_value_id) REFERENCES public.product_option_values(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.variant_option_values
    ADD CONSTRAINT variant_option_values_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE;

ALTER TABLE public.metafields
    ADD FOREIGN KEY (owner_product_id) REFERENCES public.products(id) ON DELETE CASCADE,
    ADD FOREIGN KEY (owner_variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE,
    ADD FOREIGN KEY (owner_category_id) REFERENCES public.categories(id) ON DELETE CASCADE,
    ADD FOREIGN KEY (owner_customer_id) REFERENCES public.customers(id) ON DELETE CASCADE,
    ADD FOREIGN KEY (owner_order_id) REFERENCES public.orders(id) ON DELETE CASCADE;
CREATE INDEX metafields_product_fk_idx ON public.metafields(owner_product_id) WHERE owner_product_id IS NOT NULL;
CREATE INDEX metafields_variant_fk_idx ON public.metafields(owner_variant_id) WHERE owner_variant_id IS NOT NULL;
CREATE INDEX metafields_category_fk_idx ON public.metafields(owner_category_id) WHERE owner_category_id IS NOT NULL;
CREATE INDEX metafields_customer_fk_idx ON public.metafields(owner_customer_id) WHERE owner_customer_id IS NOT NULL;
CREATE INDEX metafields_order_fk_idx ON public.metafields(owner_order_id) WHERE owner_order_id IS NOT NULL;

-- Transaction-local in effect: one queued validation per dirty order, removed
-- by its deferred constraint trigger before commit. MVCC handles savepoint
-- rollback and re-enqueue after SET CONSTRAINTS; no session/GUC skip flags.
CREATE TABLE private.order_validation_queue (
    order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE
);
ALTER TABLE private.order_validation_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.order_validation_queue FROM PUBLIC, anon, authenticated, service_role;

-- Return authorization, physical receipt, and inspection decisions are not refunds.
-- A return is scoped to one existing shipment; multiple shipments use multiple returns.
CREATE TABLE commerce.returns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id uuid NOT NULL,
    fulfillment_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
    reason text CHECK (length(reason) <= 500),
    idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    CHECK ((status = 'open') = (closed_at IS NULL)),
    CHECK (closed_at >= created_at),
    UNIQUE (fulfillment_id, idempotency_key),
    UNIQUE (id, order_id, fulfillment_id),
    UNIQUE (id, order_id),
    FOREIGN KEY (fulfillment_id, order_id) REFERENCES public.fulfillments(id, order_id) ON DELETE RESTRICT
);
CREATE TABLE commerce.return_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id uuid NOT NULL,
    order_id uuid NOT NULL,
    fulfillment_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    quantity integer NOT NULL CHECK (quantity > 0),
    UNIQUE (return_id, order_item_id),
    UNIQUE (id, return_id, order_id),
    FOREIGN KEY (return_id, order_id, fulfillment_id) REFERENCES commerce.returns(id, order_id, fulfillment_id) ON DELETE RESTRICT,
    FOREIGN KEY (fulfillment_id, order_item_id) REFERENCES commerce.fulfillment_lines(fulfillment_id, order_item_id) ON DELETE RESTRICT
);
CREATE TABLE commerce.return_receipts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id uuid NOT NULL,
    order_id uuid NOT NULL,
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
    idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    note text CHECK (length(note) <= 2000),
    actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (return_id, idempotency_key),
    UNIQUE (id, return_id, order_id),
    UNIQUE (id, order_id),
    FOREIGN KEY (return_id, order_id) REFERENCES commerce.returns(id, order_id) ON DELETE RESTRICT
);
CREATE TABLE commerce.return_receipt_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id uuid NOT NULL,
    return_id uuid NOT NULL,
    order_id uuid NOT NULL,
    return_line_id uuid NOT NULL,
    quantity integer NOT NULL CHECK (quantity > 0),
    UNIQUE (receipt_id, return_line_id),
    UNIQUE (id, receipt_id, order_id),
    FOREIGN KEY (receipt_id, return_id, order_id) REFERENCES commerce.return_receipts(id, return_id, order_id) ON DELETE RESTRICT,
    FOREIGN KEY (return_line_id, return_id, order_id) REFERENCES commerce.return_lines(id, return_id, order_id) ON DELETE RESTRICT
);
CREATE TABLE commerce.return_dispositions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_line_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    order_id uuid NOT NULL,
    quantity integer NOT NULL CHECK (quantity > 0),
    disposition text NOT NULL CHECK (disposition IN ('restock','discard')),
    inventory_movement_id bigint UNIQUE REFERENCES public.inventory_movements(id) ON DELETE RESTRICT,
    idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    note text CHECK (length(note) <= 2000),
    actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((disposition = 'restock') = (inventory_movement_id IS NOT NULL)),
    UNIQUE (receipt_line_id, idempotency_key),
    FOREIGN KEY (receipt_line_id, receipt_id, order_id) REFERENCES commerce.return_receipt_lines(id, receipt_id, order_id) ON DELETE RESTRICT
);
CREATE INDEX returns_order_idx ON commerce.returns(order_id, created_at, id);
CREATE INDEX return_lines_shipment_idx ON commerce.return_lines(fulfillment_id, order_item_id);
CREATE INDEX return_receipt_lines_return_line_idx ON commerce.return_receipt_lines(return_line_id);
CREATE INDEX return_dispositions_order_idx ON commerce.return_dispositions(order_id);
ALTER TABLE commerce.returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.return_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.return_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.return_dispositions ENABLE ROW LEVEL SECURITY;

-- Indexes

CREATE INDEX checkout_quote_lines_inventory_idx ON commerce.checkout_quote_lines USING btree (variant_id, location_id, quote_id) WHERE track_inventory;
CREATE INDEX checkout_quotes_active_idx ON commerce.checkout_quotes USING btree (expires_at, id) WHERE (status = ANY (ARRAY['open'::text, 'converted'::text]));

-- Transactional working set; immutable quote lines remain the historical source.
CREATE TABLE commerce.inventory_reservations (
    quote_line_id uuid PRIMARY KEY REFERENCES commerce.checkout_quote_lines(id),
    quote_id uuid NOT NULL REFERENCES commerce.checkout_quotes(id),
    variant_id uuid NOT NULL,
    location_id uuid NOT NULL,
    quantity integer NOT NULL CHECK (quantity > 0),
    expires_at timestamptz NOT NULL
);
CREATE INDEX inventory_reservations_inventory_idx ON commerce.inventory_reservations
    (variant_id, location_id, expires_at) INCLUDE (quantity, quote_id);
CREATE INDEX inventory_reservations_quote_idx ON commerce.inventory_reservations (quote_id);
ALTER TABLE commerce.inventory_reservations ENABLE ROW LEVEL SECURITY;
CREATE INDEX orders_payment_expiry_idx ON public.orders (payment_expires_at, id) WHERE status = 'open' AND financial_status = 'pending';
CREATE INDEX orders_customer_pending_idx ON public.orders (customer_id, payment_expires_at) WHERE status = 'open' AND financial_status = 'pending';
CREATE INDEX checkout_quotes_customer_idx ON commerce.checkout_quotes USING btree (customer_id, created_at DESC);
CREATE INDEX command_idempotency_resource_idx ON commerce.command_idempotency USING btree (resource_type, resource_id);
CREATE INDEX fulfillment_lines_order_idx ON commerce.fulfillment_lines USING btree (order_id, fulfillment_id);
CREATE INDEX fulfillment_lines_order_item_idx ON commerce.fulfillment_lines USING btree (order_item_id, fulfillment_id);
CREATE INDEX order_adjustments_order_idx ON commerce.order_adjustments USING btree (order_id, id);
CREATE INDEX order_adjustments_order_item_idx ON commerce.order_adjustments USING btree (order_item_id) WHERE (order_item_id IS NOT NULL);
CREATE INDEX outbox_events_claim_idx ON commerce.outbox_events USING btree (status, available_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text, 'processing'::text]));
CREATE UNIQUE INDEX payment_intents_one_active_per_order_uk ON commerce.payment_intents USING btree (order_id) WHERE (status = ANY (ARRAY['requires_action'::text, 'processing'::text]));
CREATE INDEX payment_intents_order_idx ON commerce.payment_intents USING btree (order_id, created_at DESC);
CREATE UNIQUE INDEX payment_intents_provider_reference_uk ON commerce.payment_intents USING btree (provider, provider_reference) WHERE (provider_reference IS NOT NULL);
CREATE INDEX payment_intents_capture_poll_idx ON commerce.payment_intents
    (coalesce(last_provider_poll_at, provider_capture_requested_at), id)
    WHERE provider = 'paypal' AND provider_capture_requested_at IS NOT NULL
      AND provider_reference IS NOT NULL AND status IN ('requires_action', 'processing', 'cancelled');
CREATE INDEX payment_provider_events_object_idx ON commerce.payment_provider_events USING btree (provider, object_reference, created_at) WHERE (object_reference IS NOT NULL);
CREATE INDEX payment_provider_events_retry_idx ON commerce.payment_provider_events USING btree (status, created_at, id) WHERE (status = ANY (ARRAY['received'::text, 'failed'::text]));
CREATE INDEX payment_transactions_intent_idx ON commerce.payment_transactions USING btree (payment_intent_id, created_at DESC) WHERE (payment_intent_id IS NOT NULL);
CREATE INDEX payment_transactions_order_idx ON commerce.payment_transactions USING btree (order_id, created_at DESC);
CREATE INDEX payment_transactions_parent_idx ON commerce.payment_transactions USING btree (parent_transaction_id) WHERE (parent_transaction_id IS NOT NULL);
CREATE UNIQUE INDEX payment_transactions_provider_idempotency_uk ON commerce.payment_transactions USING btree (provider, idempotency_key) WHERE (idempotency_key IS NOT NULL);
CREATE INDEX provider_money_movements_order_idx ON commerce.provider_money_movements USING btree (order_id, created_at DESC) WHERE (order_id IS NOT NULL);
CREATE INDEX provider_money_movements_capture_intent_idx ON commerce.provider_money_movements
    (payment_intent_id) WHERE kind = 'capture' AND payment_intent_id IS NOT NULL;
CREATE INDEX provider_money_movements_reconcile_idx ON commerce.provider_money_movements USING btree (reconciliation_status, created_at, id) WHERE (reconciliation_status <> 'matched'::text);
CREATE INDEX refund_lines_order_item_idx ON commerce.refund_lines USING btree (order_item_id, refund_id);
CREATE INDEX refund_request_lines_item_idx ON commerce.refund_request_lines USING btree (order_item_id, refund_request_id);
CREATE INDEX refund_requests_active_idx ON commerce.refund_requests USING btree (order_id, parent_transaction_id, id) WHERE (status = ANY (ARRAY['requested'::text, 'submitted'::text, 'processing'::text]));
CREATE INDEX refund_requests_order_idx ON commerce.refund_requests USING btree (order_id, created_at DESC);
CREATE INDEX refund_requests_provider_poll_idx ON commerce.refund_requests USING btree (provider, COALESCE(last_provider_poll_at, created_at), created_at, id) WHERE ((provider_reference IS NOT NULL) AND (status = ANY (ARRAY['submitted'::text, 'processing'::text])));
CREATE UNIQUE INDEX refund_requests_provider_reference_uk ON commerce.refund_requests USING btree (provider, provider_reference) WHERE (provider_reference IS NOT NULL);
CREATE INDEX refunds_order_idx ON commerce.refunds USING btree (order_id, created_at DESC);
CREATE INDEX addresses_customer_idx ON public.addresses USING btree (customer_id);
CREATE UNIQUE INDEX addresses_one_default_per_customer_idx ON public.addresses USING btree (customer_id) WHERE is_default;
ALTER TABLE commerce.carts ADD FOREIGN KEY (shipping_method_id) REFERENCES public.shipping_methods(id) ON DELETE RESTRICT;
ALTER TABLE commerce.cart_lines ADD FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE RESTRICT;
ALTER TABLE commerce.outbox_redrives ADD FOREIGN KEY (event_id) REFERENCES commerce.outbox_events(event_id) ON DELETE RESTRICT;
ALTER TABLE commerce.order_shipping_lines
  ADD FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (shipping_method_id) REFERENCES public.shipping_methods(id) ON DELETE RESTRICT;
ALTER TABLE commerce.order_tax_lines
  ADD FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (order_item_id, order_id) REFERENCES public.order_items(id, order_id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (shipping_line_id, order_id) REFERENCES commerce.order_shipping_lines(id, order_id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (tax_rate_id) REFERENCES public.tax_rates(id) ON DELETE RESTRICT;
ALTER TABLE commerce.order_discount_allocations
  ADD FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (order_item_id, order_id) REFERENCES public.order_items(id, order_id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (shipping_line_id, order_id) REFERENCES commerce.order_shipping_lines(id, order_id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (order_id, promotion_id) REFERENCES public.order_promotions(order_id, promotion_id) ON DELETE RESTRICT;
ALTER TABLE commerce.refund_components
  ADD FOREIGN KEY (refund_id, order_id) REFERENCES commerce.refunds(id, order_id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (tax_line_id, order_id) REFERENCES commerce.order_tax_lines(id, order_id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (shipping_line_id, order_id) REFERENCES commerce.order_shipping_lines(id, order_id) ON DELETE RESTRICT;
ALTER TABLE commerce.refund_request_components
  ADD FOREIGN KEY (refund_request_id, order_id) REFERENCES commerce.refund_requests(id, order_id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (tax_line_id, order_id) REFERENCES commerce.order_tax_lines(id, order_id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (shipping_line_id, order_id) REFERENCES commerce.order_shipping_lines(id, order_id) ON DELETE RESTRICT;
CREATE INDEX order_tax_lines_item_idx ON commerce.order_tax_lines(order_item_id);
CREATE INDEX refund_components_tax_idx ON commerce.refund_components(tax_line_id) WHERE tax_line_id IS NOT NULL;
CREATE INDEX refund_components_shipping_idx ON commerce.refund_components(shipping_line_id) WHERE shipping_line_id IS NOT NULL;
CREATE INDEX refund_request_components_tax_idx ON commerce.refund_request_components(tax_line_id) WHERE tax_line_id IS NOT NULL;
CREATE INDEX refund_request_components_shipping_idx ON commerce.refund_request_components(shipping_line_id) WHERE shipping_line_id IS NOT NULL;

CREATE INDEX categories_parent_idx ON public.categories USING btree (parent_id);
CREATE INDEX customers_created_idx ON public.customers USING btree (created_at DESC, id DESC);
CREATE INDEX discount_redemptions_lookup_idx ON public.discount_redemptions USING btree (promotion_id, customer_id);
CREATE INDEX discount_redemptions_order_idx ON public.discount_redemptions USING btree (order_id);
CREATE INDEX fulfillments_order_idx ON public.fulfillments USING btree (order_id);
CREATE INDEX inventory_levels_location_idx ON public.inventory_levels USING btree (location_id);
CREATE INDEX inventory_movements_location_idx ON public.inventory_movements USING btree (location_id);
CREATE INDEX inventory_movements_order_idx ON public.inventory_movements USING btree (order_id);
CREATE INDEX inventory_movements_variant_idx ON public.inventory_movements USING btree (variant_id, created_at DESC);
CREATE UNIQUE INDEX locations_single_default_idx ON public.locations USING btree (is_default) WHERE (is_default AND is_active);
CREATE INDEX metafields_filter_idx ON public.metafields USING btree (owner_type, namespace, key);
CREATE INDEX metafields_owner_idx ON public.metafields USING btree (owner_type, owner_id);
CREATE INDEX metafields_value_gin_idx ON public.metafields USING gin (value jsonb_path_ops);
CREATE INDEX metaobjects_definition_idx ON public.metaobjects USING btree (definition_id);
CREATE INDEX order_events_order_idx ON public.order_events USING btree (order_id);
CREATE INDEX order_items_order_idx ON public.order_items USING btree (order_id);
CREATE INDEX order_items_variant_idx ON public.order_items USING btree (variant_id);
CREATE INDEX orders_created_at_idx ON public.orders USING btree (created_at DESC);
CREATE INDEX orders_customer_idx ON public.orders USING btree (customer_id, order_number DESC);
CREATE INDEX orders_status_idx ON public.orders USING btree (status, financial_status, fulfillment_status);
CREATE INDEX product_categories_category_idx ON public.product_categories USING btree (category_id);
CREATE INDEX product_images_product_idx ON public.product_images USING btree (product_id);
CREATE INDEX product_reviews_customer_idx ON public.product_reviews USING btree (customer_id);
CREATE INDEX product_reviews_product_idx ON public.product_reviews USING btree (product_id, status);
CREATE INDEX product_variants_product_idx ON public.product_variants USING btree (product_id);
CREATE INDEX products_admin_updated_idx ON public.products USING btree (updated_at DESC, id DESC);
CREATE INDEX products_status_idx ON public.products USING btree (status);
CREATE INDEX products_type_idx ON public.products USING btree (product_type);
CREATE INDEX promotion_targets_category_idx ON public.promotion_targets USING btree (category_id);
CREATE INDEX promotion_targets_product_idx ON public.promotion_targets USING btree (product_id);
CREATE UNIQUE INDEX promotion_targets_unique ON public.promotion_targets USING btree (promotion_id, role, product_id, category_id, variant_id) NULLS NOT DISTINCT;
CREATE INDEX promotion_targets_variant_idx ON public.promotion_targets USING btree (variant_id);
CREATE UNIQUE INDEX tax_rates_one_active_country_idx ON public.tax_rates USING btree (country) WHERE is_active;
CREATE INDEX variant_option_values_value_idx ON public.variant_option_values USING btree (option_value_id);

-- Zero consideration still has a quantity lifecycle; it is not a money refund.
CREATE TABLE commerce.zero_value_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  order_item_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  restocked_quantity integer NOT NULL DEFAULT 0 CHECK (restocked_quantity BETWEEN 0 AND quantity),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  reason text CHECK (length(reason) <= 2000),
  actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, idempotency_key),
  FOREIGN KEY (order_item_id, order_id) REFERENCES public.order_items(id, order_id) ON DELETE RESTRICT
);
CREATE INDEX zero_value_cancellations_item_idx ON commerce.zero_value_cancellations(order_item_id);
ALTER TABLE commerce.zero_value_cancellations ENABLE ROW LEVEL SECURITY;

-- JSON remains the ordered content; these derived edges enforce target lifetime.
CREATE TABLE private.metafield_metaobject_refs (
  metafield_id uuid NOT NULL REFERENCES public.metafields(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES public.metaobjects(id) ON DELETE RESTRICT,
  PRIMARY KEY (metafield_id, target_id)
);
CREATE INDEX metafield_metaobject_refs_target_idx ON private.metafield_metaobject_refs(target_id);
ALTER TABLE private.metafield_metaobject_refs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.metafield_metaobject_refs FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE commerce.order_shipping_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.order_tax_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.order_discount_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.refund_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.refund_request_components ENABLE ROW LEVEL SECURITY;

-- All application tables require explicit RLS policies

ALTER TABLE commerce.carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.cart_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.checkout_quote_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.checkout_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.command_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.fulfillment_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.order_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.outbox_redrives ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.payment_provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.provider_money_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.refund_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.refund_request_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.refund_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discount_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fulfillments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.metafield_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.metafields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.metaobject_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.metaobjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_option_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotion_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipping_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.variant_option_values ENABLE ROW LEVEL SECURITY;

commit;
