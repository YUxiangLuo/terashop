-- Attach invariants and publish the explicit API allowlist only after all functions exist.
begin;

-- Storefront view

CREATE VIEW public.product_listing AS
 WITH active_reservations AS MATERIALIZED (
         SELECT ql.variant_id,
            ql.location_id,
            (sum(ql.quantity))::integer AS reserved
           FROM (commerce.checkout_quote_lines ql
             JOIN commerce.checkout_quotes q ON ((q.id = ql.quote_id)))
          WHERE (ql.track_inventory AND (q.status = ANY (ARRAY['open'::text, 'converted'::text])) AND (q.expires_at > now()))
          GROUP BY ql.variant_id, ql.location_id
        ), default_location AS MATERIALIZED (
         SELECT l.id
           FROM public.locations l
          WHERE (l.is_default AND l.is_active)
          ORDER BY l.id
         LIMIT 1
        )
 SELECT id,
    slug,
    name,
    description,
    vendor,
    product_type,
    tags,
    created_at,
    ( SELECT min(v.price) AS min
           FROM public.product_variants v
          WHERE ((v.product_id = p.id) AND v.is_active)) AS price_from,
    (( SELECT v.compare_at_price
           FROM public.product_variants v
          WHERE ((v.product_id = p.id) AND v.is_active)
          ORDER BY v.price, v.id
         LIMIT 1))::numeric AS compare_at_from,
    ( SELECT i.url
           FROM public.product_images i
          WHERE (i.product_id = p.id)
          ORDER BY i."position", i.id
         LIMIT 1) AS primary_image,
    ( SELECT array_agg(c.slug ORDER BY c.slug) AS array_agg
           FROM (public.product_categories pc
             JOIN public.categories c ON ((c.id = pc.category_id)))
          WHERE ((pc.product_id = p.id) AND c.is_active)) AS categories,
    COALESCE(( SELECT bool_or(((NOT v.track_inventory) OR ((COALESCE(il.on_hand, 0) - COALESCE(ar.reserved, 0)) > 0))) AS bool_or
           FROM (((public.product_variants v
             LEFT JOIN default_location dl ON (true))
             LEFT JOIN public.inventory_levels il ON (((il.variant_id = v.id) AND (il.location_id = dl.id))))
             LEFT JOIN active_reservations ar ON (((ar.variant_id = v.id) AND (ar.location_id = dl.id))))
          WHERE ((v.product_id = p.id) AND v.is_active)), false) AS in_stock
   FROM public.products p
  WHERE (status = 'active'::text);

-- Transaction and audit triggers

CREATE TRIGGER checkout_quote_lines_immutable BEFORE DELETE OR UPDATE ON commerce.checkout_quote_lines FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE CONSTRAINT TRIGGER checkout_quote_lines_match_header AFTER INSERT OR DELETE OR UPDATE ON commerce.checkout_quote_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_checkout_quote_totals();
CREATE TRIGGER checkout_quote_lines_no_truncate BEFORE TRUNCATE ON commerce.checkout_quote_lines FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER checkout_quote_lines_reservation_validate BEFORE INSERT ON commerce.checkout_quote_lines FOR EACH ROW EXECUTE FUNCTION private.validate_checkout_quote_line_reservation();
CREATE TRIGGER checkout_quotes_enqueue_outbox AFTER INSERT OR UPDATE OF status ON commerce.checkout_quotes FOR EACH ROW EXECUTE FUNCTION private.checkout_quote_to_outbox();
CREATE TRIGGER checkout_quotes_no_truncate BEFORE TRUNCATE ON commerce.checkout_quotes FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE CONSTRAINT TRIGGER checkout_quotes_require_lines AFTER INSERT ON commerce.checkout_quotes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_checkout_quote_totals();
CREATE TRIGGER checkout_quotes_validate BEFORE DELETE OR UPDATE ON commerce.checkout_quotes FOR EACH ROW EXECUTE FUNCTION private.validate_checkout_quote();
CREATE TRIGGER command_idempotency_immutable BEFORE DELETE OR UPDATE ON commerce.command_idempotency FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER command_idempotency_no_truncate BEFORE TRUNCATE ON commerce.command_idempotency FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER fulfillment_lines_immutable BEFORE DELETE OR UPDATE ON commerce.fulfillment_lines FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER fulfillment_lines_no_truncate BEFORE TRUNCATE ON commerce.fulfillment_lines FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER fulfillment_lines_validate BEFORE INSERT ON commerce.fulfillment_lines FOR EACH ROW EXECUTE FUNCTION private.validate_fulfillment_line();
CREATE TRIGGER order_adjustments_append_only BEFORE DELETE OR UPDATE ON commerce.order_adjustments FOR EACH ROW EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER order_adjustments_no_truncate BEFORE TRUNCATE ON commerce.order_adjustments FOR EACH STATEMENT EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER outbox_events_no_truncate BEFORE TRUNCATE ON commerce.outbox_events FOR EACH STATEMENT EXECUTE FUNCTION private.protect_outbox_event();
CREATE TRIGGER outbox_events_protect BEFORE DELETE OR UPDATE ON commerce.outbox_events FOR EACH ROW EXECUTE FUNCTION private.protect_outbox_event();
CREATE TRIGGER payment_intents_capture_marker_immutable BEFORE UPDATE OF provider_capture_requested_at ON commerce.payment_intents FOR EACH ROW EXECUTE FUNCTION private.protect_capture_request_marker();
CREATE TRIGGER payment_intents_enqueue_outbox AFTER INSERT OR UPDATE OF status ON commerce.payment_intents FOR EACH ROW EXECUTE FUNCTION private.payment_intent_to_outbox();
CREATE TRIGGER payment_intents_no_delete BEFORE DELETE ON commerce.payment_intents FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER payment_intents_no_truncate BEFORE TRUNCATE ON commerce.payment_intents FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER payment_intents_validate BEFORE INSERT OR UPDATE ON commerce.payment_intents FOR EACH ROW EXECUTE FUNCTION private.validate_payment_intent();
CREATE TRIGGER payment_provider_events_no_delete BEFORE DELETE ON commerce.payment_provider_events FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER payment_provider_events_no_truncate BEFORE TRUNCATE ON commerce.payment_provider_events FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER payment_provider_events_validate BEFORE INSERT OR UPDATE ON commerce.payment_provider_events FOR EACH ROW EXECUTE FUNCTION private.validate_payment_provider_event();
CREATE TRIGGER payment_transactions_enqueue_outbox AFTER INSERT OR UPDATE OF status ON commerce.payment_transactions FOR EACH ROW EXECUTE FUNCTION private.payment_transaction_to_outbox();
CREATE TRIGGER payment_transactions_no_delete BEFORE DELETE ON commerce.payment_transactions FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER payment_transactions_no_truncate BEFORE TRUNCATE ON commerce.payment_transactions FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER payment_transactions_validate BEFORE INSERT OR UPDATE ON commerce.payment_transactions FOR EACH ROW EXECUTE FUNCTION private.validate_payment_transaction();
CREATE TRIGGER provider_money_movements_no_delete BEFORE DELETE ON commerce.provider_money_movements FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER provider_money_movements_no_truncate BEFORE TRUNCATE ON commerce.provider_money_movements FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER provider_money_movements_validate BEFORE INSERT OR UPDATE ON commerce.provider_money_movements FOR EACH ROW EXECUTE FUNCTION private.validate_provider_money_movement();
CREATE TRIGGER refund_lines_allocate_cancellation BEFORE INSERT ON commerce.refund_lines FOR EACH ROW EXECUTE FUNCTION private.allocate_refund_cancellation();
CREATE TRIGGER refund_lines_immutable BEFORE DELETE OR UPDATE ON commerce.refund_lines FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER refund_lines_no_truncate BEFORE TRUNCATE ON commerce.refund_lines FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE CONSTRAINT TRIGGER refund_lines_refresh_fulfillment AFTER INSERT ON commerce.refund_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.refresh_fulfillment_after_refund();
CREATE CONSTRAINT TRIGGER refund_lines_total_matches_header AFTER INSERT OR DELETE OR UPDATE ON commerce.refund_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_refund_lines_total();
CREATE TRIGGER refund_request_lines_allocate_cancellation BEFORE INSERT ON commerce.refund_request_lines FOR EACH ROW EXECUTE FUNCTION private.allocate_refund_request_cancellation();
CREATE TRIGGER refund_request_lines_immutable BEFORE DELETE OR UPDATE ON commerce.refund_request_lines FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE CONSTRAINT TRIGGER refund_request_lines_match_header AFTER INSERT OR DELETE OR UPDATE ON commerce.refund_request_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_refund_request_lines();
CREATE TRIGGER refund_request_lines_no_truncate BEFORE TRUNCATE ON commerce.refund_request_lines FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER refund_request_lines_validate BEFORE INSERT ON commerce.refund_request_lines FOR EACH ROW EXECUTE FUNCTION private.validate_refund_request_line();
CREATE TRIGGER refund_requests_enqueue_outbox AFTER INSERT OR UPDATE OF status ON commerce.refund_requests FOR EACH ROW EXECUTE FUNCTION private.refund_request_to_outbox();
CREATE TRIGGER refund_requests_no_delete BEFORE DELETE ON commerce.refund_requests FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER refund_requests_no_truncate BEFORE TRUNCATE ON commerce.refund_requests FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER refund_requests_provider_reversal_guard BEFORE INSERT ON commerce.refund_requests FOR EACH ROW EXECUTE FUNCTION private.prevent_refund_after_provider_reversal();
CREATE CONSTRAINT TRIGGER refund_requests_require_lines AFTER INSERT ON commerce.refund_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_refund_request_lines();
CREATE TRIGGER refund_requests_validate BEFORE INSERT OR UPDATE ON commerce.refund_requests FOR EACH ROW EXECUTE FUNCTION private.validate_refund_request();
CREATE TRIGGER refunds_append_only BEFORE DELETE OR UPDATE ON commerce.refunds FOR EACH ROW EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER refunds_enqueue_outbox AFTER INSERT ON commerce.refunds FOR EACH ROW EXECUTE FUNCTION private.refund_to_outbox();
CREATE TRIGGER refunds_no_truncate BEFORE TRUNCATE ON commerce.refunds FOR EACH STATEMENT EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER refunds_validate BEFORE INSERT ON commerce.refunds FOR EACH ROW EXECUTE FUNCTION private.validate_refund_header();
CREATE TRIGGER addresses_default_command_guard BEFORE UPDATE ON public.addresses FOR EACH ROW EXECUTE FUNCTION private.protect_address_identity_and_default();
CREATE TRIGGER addresses_normalize_country BEFORE INSERT OR UPDATE OF country ON public.addresses FOR EACH ROW EXECUTE FUNCTION private.normalize_address_country();
CREATE TRIGGER addresses_single_default BEFORE INSERT ON public.addresses FOR EACH ROW WHEN (new.is_default) EXECUTE FUNCTION public.enforce_single_default_address();
CREATE TRIGGER addresses_updated_at BEFORE UPDATE ON public.addresses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER categories_updated_at BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER fulfillments_commercial_fields_immutable BEFORE DELETE OR UPDATE ON public.fulfillments FOR EACH ROW EXECUTE FUNCTION private.protect_fulfillment_record();
CREATE TRIGGER fulfillments_no_truncate BEFORE TRUNCATE ON public.fulfillments FOR EACH STATEMENT EXECUTE FUNCTION private.protect_fulfillment_record();
CREATE TRIGGER fulfillments_quoted_order_paid BEFORE INSERT ON public.fulfillments FOR EACH ROW EXECUTE FUNCTION private.prevent_unpaid_quoted_fulfillment();
CREATE TRIGGER fulfillments_recalculate_order AFTER UPDATE OF status ON public.fulfillments FOR EACH ROW EXECUTE FUNCTION private.recalculate_order_fulfillment();
CREATE TRIGGER fulfillments_refund_cancellation_guard BEFORE UPDATE OF status ON public.fulfillments FOR EACH ROW EXECUTE FUNCTION private.prevent_refunded_fulfillment_cancellation();
CREATE TRIGGER fulfillments_sync_lines AFTER INSERT ON public.fulfillments FOR EACH ROW EXECUTE FUNCTION private.sync_fulfillment_lines();
CREATE TRIGGER fulfillments_updated_at BEFORE UPDATE ON public.fulfillments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER inventory_levels_reservation_guard BEFORE DELETE OR UPDATE ON public.inventory_levels FOR EACH ROW EXECUTE FUNCTION private.protect_reserved_inventory();
CREATE TRIGGER inventory_movements_append_only BEFORE DELETE OR UPDATE ON public.inventory_movements FOR EACH ROW EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER inventory_movements_no_truncate BEFORE TRUNCATE ON public.inventory_movements FOR EACH STATEMENT EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER metafield_definitions_existing_values_compatible BEFORE INSERT OR UPDATE OF owner_type, namespace, key, type ON public.metafield_definitions FOR EACH ROW EXECUTE FUNCTION private.enforce_metafield_definition_compatibility();
CREATE TRIGGER metafield_definitions_updated_at BEFORE UPDATE ON public.metafield_definitions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER metafields_definition_integrity BEFORE INSERT OR UPDATE ON public.metafields FOR EACH ROW EXECUTE FUNCTION private.enforce_metafield_integrity();
CREATE TRIGGER metafields_updated_at BEFORE UPDATE ON public.metafields FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER metafields_validate BEFORE INSERT OR UPDATE ON public.metafields FOR EACH ROW EXECUTE FUNCTION public.validate_metafield_value();
CREATE TRIGGER metaobject_definitions_updated_at BEFORE UPDATE ON public.metaobject_definitions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER metaobjects_updated_at BEFORE UPDATE ON public.metaobjects FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER order_events_append_only BEFORE DELETE OR UPDATE ON public.order_events FOR EACH ROW EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER order_events_enqueue_outbox AFTER INSERT ON public.order_events FOR EACH ROW EXECUTE FUNCTION private.order_event_to_outbox();
CREATE TRIGGER order_events_no_truncate BEFORE TRUNCATE ON public.order_events FOR EACH STATEMENT EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER order_items_payment_snapshot_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.order_items FOR EACH ROW EXECUTE FUNCTION private.protect_order_items_during_payment();
CREATE TRIGGER order_items_quoted_order_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.order_items FOR EACH ROW EXECUTE FUNCTION private.protect_quoted_order_items();
CREATE TRIGGER order_items_snapshot_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.order_items FOR EACH ROW EXECUTE FUNCTION private.protect_order_item_snapshot();
CREATE TRIGGER orders_adjustment_ledger_insert AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION private.sync_order_adjustments();
CREATE TRIGGER orders_adjustment_ledger_update AFTER UPDATE OF subtotal, discount_total, shipping_total, tax_total, total, currency ON public.orders FOR EACH ROW EXECUTE FUNCTION private.sync_order_adjustments();
CREATE TRIGGER orders_financial_status_validate BEFORE UPDATE OF financial_status ON public.orders FOR EACH ROW EXECUTE FUNCTION private.validate_order_financial_status();
CREATE TRIGGER orders_no_delete BEFORE DELETE ON public.orders FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER orders_no_truncate BEFORE TRUNCATE ON public.orders FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER orders_paid_snapshot_immutable BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION private.protect_paid_order_snapshot();
CREATE TRIGGER orders_payment_snapshot_immutable BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION private.protect_order_payment_snapshot();
CREATE TRIGGER orders_paypal_capture_guard BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION private.protect_order_during_paypal_capture();
CREATE TRIGGER orders_quote_payment_guard BEFORE UPDATE OF financial_status ON public.orders FOR EACH ROW EXECUTE FUNCTION private.require_consumed_quote_before_payment();
CREATE TRIGGER orders_quoted_snapshot_immutable BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION private.protect_quoted_order_snapshot();
CREATE TRIGGER orders_sync_cancelled_quote AFTER UPDATE OF status ON public.orders FOR EACH ROW EXECUTE FUNCTION private.sync_cancelled_order_quote();
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER payments_async_refund_guard BEFORE INSERT ON public.payments FOR EACH ROW EXECUTE FUNCTION private.prevent_refund_during_async_request();
CREATE TRIGGER payments_commercial_fields_immutable BEFORE DELETE OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION private.protect_legacy_payment();
CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON public.payments FOR EACH STATEMENT EXECUTE FUNCTION private.protect_legacy_payment();
CREATE TRIGGER payments_sync_transaction_insert AFTER INSERT ON public.payments FOR EACH ROW EXECUTE FUNCTION private.sync_legacy_payment_transaction();
CREATE TRIGGER payments_sync_transaction_update AFTER UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION private.sync_legacy_payment_transaction();
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER product_reviews_remoderate BEFORE UPDATE ON public.product_reviews FOR EACH ROW EXECUTE FUNCTION public.review_edit_requires_moderation();
CREATE TRIGGER product_reviews_updated_at BEFORE UPDATE ON public.product_reviews FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER product_variants_updated_at BEFORE UPDATE ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER products_updated_at BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER promotions_normalize_code BEFORE INSERT OR UPDATE OF code ON public.promotions FOR EACH ROW EXECUTE FUNCTION public.normalize_promotion_code();
CREATE TRIGGER promotions_updated_at BEFORE UPDATE ON public.promotions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER promotions_validate BEFORE INSERT OR UPDATE ON public.promotions FOR EACH ROW EXECUTE FUNCTION public.validate_promotion_params();
CREATE TRIGGER shipping_methods_normalize_countries BEFORE INSERT OR UPDATE OF countries ON public.shipping_methods FOR EACH ROW EXECUTE FUNCTION private.normalize_shipping_countries();
CREATE TRIGGER shipping_methods_updated_at BEFORE UPDATE ON public.shipping_methods FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER tax_rates_normalize_country BEFORE INSERT OR UPDATE OF country ON public.tax_rates FOR EACH ROW EXECUTE FUNCTION private.normalize_tax_country();

-- Supabase Auth integration triggers

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();
CREATE TRIGGER on_auth_user_email_updated AFTER UPDATE OF email ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_user_email_change();

-- Row-level policies

CREATE POLICY "addresses: own all" ON public.addresses USING (((auth.uid() = customer_id) OR public.is_admin()));
CREATE POLICY "categories: admin write" ON public.categories USING (public.is_admin());
CREATE POLICY "categories: public read" ON public.categories FOR SELECT USING ((is_active OR public.is_admin()));
CREATE POLICY "discount_redemptions: read own or admin" ON public.discount_redemptions FOR SELECT USING (((auth.uid() = customer_id) OR public.is_admin()));
CREATE POLICY "fulfillments: read own or admin" ON public.fulfillments FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = fulfillments.order_id) AND ((o.customer_id = auth.uid()) OR public.is_admin())))));
CREATE POLICY "inventory_levels: admin all" ON public.inventory_levels USING (public.is_admin());
CREATE POLICY "inventory_movements: admin read" ON public.inventory_movements FOR SELECT USING (public.is_admin());
CREATE POLICY "locations: admin write" ON public.locations USING (public.is_admin());
CREATE POLICY "locations: public read active" ON public.locations FOR SELECT USING ((is_active OR public.is_admin()));
CREATE POLICY "metafield_definitions: admin write" ON public.metafield_definitions USING (public.is_admin());
CREATE POLICY "metafield_definitions: public read" ON public.metafield_definitions FOR SELECT USING (true);
CREATE POLICY "metafields: admin write" ON public.metafields USING (public.is_admin());
CREATE POLICY "metafields: order owner read" ON public.metafields FOR SELECT USING (((owner_type = 'order'::text) AND (EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = metafields.owner_id) AND (o.customer_id = auth.uid()))))));
CREATE POLICY "metafields: scoped read" ON public.metafields FOR SELECT USING ((public.is_admin() OR (owner_type = 'shop'::text) OR ((owner_type = 'customer'::text) AND (owner_id = auth.uid())) OR ((owner_type = 'product'::text) AND (EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = metafields.owner_id) AND (p.status = 'active'::text))))) OR ((owner_type = 'variant'::text) AND (EXISTS ( SELECT 1
   FROM (public.product_variants v
     JOIN public.products p ON ((p.id = v.product_id)))
  WHERE ((v.id = metafields.owner_id) AND v.is_active AND (p.status = 'active'::text))))) OR ((owner_type = 'category'::text) AND (EXISTS ( SELECT 1
   FROM public.categories c
  WHERE ((c.id = metafields.owner_id) AND c.is_active))))));
CREATE POLICY "metaobject_definitions: admin write" ON public.metaobject_definitions USING (public.is_admin());
CREATE POLICY "metaobject_definitions: public read" ON public.metaobject_definitions FOR SELECT USING ((is_active OR public.is_admin()));
CREATE POLICY "metaobjects: admin write" ON public.metaobjects USING (public.is_admin());
CREATE POLICY "metaobjects: public read active" ON public.metaobjects FOR SELECT USING (((status = 'active'::text) OR public.is_admin()));
CREATE POLICY "order_events: read own or admin" ON public.order_events FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = order_events.order_id) AND ((o.customer_id = auth.uid()) OR public.is_admin())))));
CREATE POLICY "order_items: read own or admin" ON public.order_items FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = order_items.order_id) AND ((o.customer_id = auth.uid()) OR public.is_admin())))));
CREATE POLICY "order_promotions: read own or admin" ON public.order_promotions FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = order_promotions.order_id) AND ((o.customer_id = auth.uid()) OR public.is_admin())))));
CREATE POLICY "orders: admin update" ON public.orders FOR UPDATE USING (public.is_admin());
CREATE POLICY "orders: read own or admin" ON public.orders FOR SELECT USING (((auth.uid() = customer_id) OR public.is_admin()));
CREATE POLICY "payments: read own or admin" ON public.payments FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = payments.order_id) AND ((o.customer_id = auth.uid()) OR public.is_admin())))));
CREATE POLICY "product_categories: admin write" ON public.product_categories USING (public.is_admin());
CREATE POLICY "product_categories: public read published" ON public.product_categories FOR SELECT USING ((public.is_admin() OR ((EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_categories.product_id) AND (p.status = 'active'::text)))) AND (EXISTS ( SELECT 1
   FROM public.categories c
  WHERE ((c.id = product_categories.category_id) AND c.is_active))))));
CREATE POLICY "product_images: admin write" ON public.product_images USING (public.is_admin());
CREATE POLICY "product_images: public read published" ON public.product_images FOR SELECT USING ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_images.product_id) AND (p.status = 'active'::text))))));
CREATE POLICY "product_option_values: admin write" ON public.product_option_values USING (public.is_admin());
CREATE POLICY "product_option_values: public read published" ON public.product_option_values FOR SELECT USING ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM (public.product_options po
     JOIN public.products p ON ((p.id = po.product_id)))
  WHERE ((po.id = product_option_values.option_id) AND (p.status = 'active'::text))))));
CREATE POLICY "product_options: admin write" ON public.product_options USING (public.is_admin());
CREATE POLICY "product_options: public read published" ON public.product_options FOR SELECT USING ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_options.product_id) AND (p.status = 'active'::text))))));
CREATE POLICY "product_reviews: admin all" ON public.product_reviews USING (public.is_admin());
CREATE POLICY "product_reviews: customer insert own" ON public.product_reviews FOR INSERT WITH CHECK (((auth.uid() = customer_id) AND (status = 'pending'::text) AND (EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_reviews.product_id) AND (p.status = 'active'::text))))));
CREATE POLICY "product_reviews: customer update own" ON public.product_reviews FOR UPDATE USING ((auth.uid() = customer_id));
CREATE POLICY "product_reviews: public read approved" ON public.product_reviews FOR SELECT USING ((public.is_admin() OR (auth.uid() = customer_id) OR ((status = 'approved'::text) AND (EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_reviews.product_id) AND (p.status = 'active'::text)))))));
CREATE POLICY "product_variants: admin write" ON public.product_variants USING (public.is_admin());
CREATE POLICY "product_variants: public read published" ON public.product_variants FOR SELECT USING ((public.is_admin() OR (is_active AND (EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_variants.product_id) AND (p.status = 'active'::text)))))));
CREATE POLICY "products: admin write" ON public.products USING (public.is_admin());
CREATE POLICY "products: public read active" ON public.products FOR SELECT USING (((status = 'active'::text) OR public.is_admin()));
CREATE POLICY "profiles: read own or admin" ON public.profiles FOR SELECT USING (((auth.uid() = id) OR public.is_admin()));
CREATE POLICY "profiles: update own" ON public.profiles FOR UPDATE USING ((auth.uid() = id));
CREATE POLICY "promotion_targets: admin write" ON public.promotion_targets USING (public.is_admin());
CREATE POLICY "promotion_targets: public read" ON public.promotion_targets FOR SELECT USING (true);
CREATE POLICY "promotions: admin write" ON public.promotions USING (public.is_admin());
CREATE POLICY "promotions: public read auto" ON public.promotions FOR SELECT USING (((code IS NULL) OR public.is_admin()));
CREATE POLICY "shipping_methods: admin write" ON public.shipping_methods USING (public.is_admin());
CREATE POLICY "shipping_methods: public read" ON public.shipping_methods FOR SELECT USING ((is_active OR public.is_admin()));
CREATE POLICY "tax_rates: admin write" ON public.tax_rates USING (public.is_admin());
CREATE POLICY "tax_rates: public read" ON public.tax_rates FOR SELECT USING ((is_active OR public.is_admin()));
CREATE POLICY "variant_option_values: admin write" ON public.variant_option_values USING (public.is_admin());
CREATE POLICY "variant_option_values: public read published" ON public.variant_option_values FOR SELECT USING ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM (public.product_variants v
     JOIN public.products p ON ((p.id = v.product_id)))
  WHERE ((v.id = variant_option_values.variant_id) AND v.is_active AND (p.status = 'active'::text))))));

-- Explicit schema, function, table and column privileges

REVOKE ALL ON FUNCTION private.active_reserved_quantity(p_variant_id uuid, p_location_id uuid, p_exclude_quote_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.allocate_refund_cancellation() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.allocate_refund_request_cancellation() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.assert_checkout_quote_totals() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.assert_refund_lines_total() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.assert_refund_request_lines() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.cancel_order(order_id uuid, reason text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.canonical_order_item_quantities(p_items jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.canonical_variant_quantities(p_items jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.checkout_pricing_hash(p_price jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.checkout_quote_json(p_quote commerce.checkout_quotes) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.checkout_quote_to_outbox() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.command_request_hash(p_request jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.consume_order_reservation(p_order_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.create_fulfillment(order_id uuid, items jsonb, carrier text, tracking_number text, tracking_url text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.create_order(items jsonb, address jsonb, address_id uuid, shipping_method_id uuid, discount_code text, note text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enforce_metafield_definition_compatibility() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enforce_metafield_integrity() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enqueue_outbox_event(p_aggregate_type text, p_aggregate_id uuid, p_event_type text, p_payload jsonb, p_idempotency_key text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.finalize_refund_request(p_request_id uuid, p_event commerce.payment_provider_events, p_data jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fulfillment_json(p_fulfillment public.fulfillments) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.mark_order_paid(order_id uuid, provider text, provider_ref text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.normalize_address_country() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.normalize_checkout_address(p_address jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.normalize_country_code(p_country text, p_allow_wildcard boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.normalize_shipping_countries() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.normalize_tax_country() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_event_to_outbox() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_item_fulfillment_balance(p_order_item_id uuid, p_unrecorded_refund_quantity integer, p_exclude_request_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.order_snapshot_has_payment_intent(p_order_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.payment_intent_json(p_intent commerce.payment_intents) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.payment_intent_to_outbox() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.payment_transaction_to_outbox() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.prevent_refund_after_provider_reversal() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.prevent_refund_during_async_request() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.prevent_refunded_fulfillment_cancellation() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.prevent_unpaid_quoted_fulfillment() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.price_checkout(items jsonb, address jsonb, shipping_method_id uuid, discount_code text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.process_payment_provider_event(p_event_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.process_paypal_payment_event(p_event commerce.payment_provider_events) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.process_paypal_refund_event(p_event commerce.payment_provider_events) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.process_stripe_payment_event(p_event commerce.payment_provider_events) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.process_stripe_refund_event(p_event commerce.payment_provider_events) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_address_identity_and_default() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_audit_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_capture_request_marker() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_fulfillment_record() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_immutable_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_legacy_payment() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_order_during_paypal_capture() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_order_item_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_order_items_during_payment() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_order_payment_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_outbox_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_paid_order_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_quoted_order_items() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_quoted_order_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_reserved_inventory() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.provider_decimal_amount(p_amount text, p_currency text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.provider_minor_amount(p_minor text, p_currency text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.provider_payment_intent_json(p_intent commerce.payment_intents) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.recalculate_order_fulfillment() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.record_provider_money_movement(p_event commerce.payment_provider_events, p_kind text, p_amount numeric, p_currency text, p_order_id uuid, p_payment_intent_id uuid, p_refund_request_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.record_stripe_money_movement(p_event commerce.payment_provider_events, p_kind text, p_amount_minor text, p_currency text, p_order_id uuid, p_payment_intent_id uuid, p_refund_request_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refresh_fulfillment_after_refund() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refresh_order_fulfillment(p_order_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refund_order(order_id uuid, items jsonb, amount numeric, reason text, restock boolean, provider text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refund_request_json(p_request commerce.refund_requests) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refund_request_to_outbox() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refund_to_outbox() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.require_consumed_quote_before_payment() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.require_reconciliation(p_movement_id uuid, p_error text, p_order_id uuid, p_payment_intent_id uuid, p_refund_request_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.resolve_checkout_address(p_customer_id uuid, p_address jsonb, p_address_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.set_user_role(user_id uuid, role text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.storefront_order_json(p_order public.orders) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.stripe_currency_exponent(p_currency text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.sync_cancelled_order_quote() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.sync_fulfillment_lines() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.sync_legacy_payment_transaction() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.sync_order_adjustments() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.update_order_address(order_id uuid, address jsonb, address_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.valid_country_codes(p_countries text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.validate_checkout_quote() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.validate_checkout_quote_line_reservation() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.validate_fulfillment_line() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.validate_order_financial_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.validate_payment_intent() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.validate_payment_provider_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.validate_payment_transaction() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.validate_provider_money_movement() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.validate_refund_header() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.validate_refund_request() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.validate_refund_request_line() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._line_in_scope(p_promotion_id uuid, p_role text, p_variant_id uuid, p_product_id uuid, p_category_ids uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.adjust_inventory(variant_id uuid, delta integer, reason text, note text, location_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.anonymize_user(p_user_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_metaobject_exists(p_ref text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_payment_intent_provider(payment_intent_id uuid, provider_reference text, provider_status text, amount numeric, currency text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_refund_request_provider(refund_request_id uuid, provider_reference text, provider_status text, amount numeric, currency text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_checkout_quote(quote_id uuid, reason text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_order(order_id uuid, reason text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_refund_request(refund_request_id uuid, actor_id uuid, provider_confirmed boolean, reason text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capture_payment_intent(payment_intent_id uuid, provider_reference text, idempotency_key text, raw jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_expired_stripe_payment_intents(max_intents integer, as_of timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_outbox_events(worker_id text, max_events integer, lease_seconds integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_outbox_event(event_id uuid, worker_id text, succeeded boolean, error_message text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_stripe_payment_intent_cancel(payment_intent_id uuid, succeeded boolean, error_code text, provider_status text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_checkout_quote(items jsonb, idempotency_key text, address jsonb, address_id uuid, shipping_method_id uuid, discount_code text, note text, ttl_seconds integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_fulfillment(order_id uuid, items jsonb, carrier text, tracking_number text, tracking_url text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_fulfillment_v2(order_id uuid, items jsonb, idempotency_key text, carrier text, tracking_number text, tracking_url text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_order(items jsonb, address jsonb, address_id uuid, shipping_method_id uuid, discount_code text, note text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_order_from_quote(quote_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_order_v2(items jsonb, idempotency_key text, address jsonb, address_id uuid, shipping_method_id uuid, discount_code text, note text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_payment_intent(order_id uuid, provider text, idempotency_key text, metadata jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_payment_intent_for_customer(order_id uuid, customer_id uuid, provider text, idempotency_key text, metadata jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_refund_request(order_id uuid, actor_id uuid, provider text, idempotency_key text, items jsonb, amount numeric, reason text, restock boolean, metadata jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_single_default_address() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_checkout_quotes(max_quotes integer, as_of timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_checkout_quote(quote_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_inventory_availability(variant_id uuid, location_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_order_checkout_quote(order_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_order_fulfillment_balance(order_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_order_ledger(order_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_payment_intent_for_customer(payment_intent_id uuid, customer_id uuid, provider text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_payment_operations(order_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_user_email_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ingest_payment_provider_event(provider text, provider_event_id text, source text, event_type text, object_reference text, livemode boolean, occurred_at timestamp with time zone, payload_hash text, data jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_pending_provider_refunds(provider text, max_requests integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_order_paid(order_id uuid, provider text, provider_ref text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.moderate_review(review_id uuid, status text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.normalize_promotion_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_paypal_capture(payment_intent_id uuid, customer_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.price_checkout(items jsonb, address jsonb, shipping_method_id uuid, discount_code text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refund_order(order_id uuid, items jsonb, amount numeric, reason text, restock boolean, provider text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refund_order_v2(order_id uuid, idempotency_key text, items jsonb, amount numeric, reason text, restock boolean, provider text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retry_payment_provider_events(max_events integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_edit_requires_moderation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_default_address(address_id uuid, make_default boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_user_role(user_id uuid, role text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_order_address(order_id uuid, address jsonb, address_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_metafield_value() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_promotion_params() FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.orders TO anon, authenticated;
GRANT ALL ON TABLE public.orders TO service_role;
GRANT ALL ON FUNCTION private.cancel_order(order_id uuid, reason text) TO service_role;
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.fulfillments TO anon, authenticated;
GRANT ALL ON TABLE public.fulfillments TO service_role;
GRANT ALL ON FUNCTION private.create_fulfillment(order_id uuid, items jsonb, carrier text, tracking_number text, tracking_url text) TO service_role;
GRANT ALL ON FUNCTION private.create_order(items jsonb, address jsonb, address_id uuid, shipping_method_id uuid, discount_code text, note text) TO service_role;
GRANT ALL ON FUNCTION private.mark_order_paid(order_id uuid, provider text, provider_ref text) TO service_role;
GRANT ALL ON FUNCTION private.price_checkout(items jsonb, address jsonb, shipping_method_id uuid, discount_code text) TO service_role;
GRANT ALL ON FUNCTION private.refund_order(order_id uuid, items jsonb, amount numeric, reason text, restock boolean, provider text) TO service_role;
GRANT ALL ON TABLE public.profiles TO anon, service_role;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.profiles TO authenticated;
GRANT ALL ON FUNCTION private.set_user_role(user_id uuid, role text) TO service_role;
GRANT ALL ON FUNCTION private.update_order_address(order_id uuid, address jsonb, address_id uuid) TO service_role;
GRANT ALL ON FUNCTION private.valid_country_codes(p_countries text[]) TO service_role, authenticated;
GRANT ALL ON FUNCTION public._line_in_scope(p_promotion_id uuid, p_role text, p_variant_id uuid, p_product_id uuid, p_category_ids uuid[]) TO service_role;
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.inventory_levels TO anon, authenticated;
GRANT ALL ON TABLE public.inventory_levels TO service_role;
GRANT ALL ON FUNCTION public.adjust_inventory(variant_id uuid, delta integer, reason text, note text, location_id uuid) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.anonymize_user(p_user_id uuid) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.assert_metaobject_exists(p_ref text) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.bind_payment_intent_provider(payment_intent_id uuid, provider_reference text, provider_status text, amount numeric, currency text) TO service_role;
GRANT ALL ON FUNCTION public.bind_refund_request_provider(refund_request_id uuid, provider_reference text, provider_status text, amount numeric, currency text) TO service_role;
GRANT ALL ON FUNCTION public.cancel_checkout_quote(quote_id uuid, reason text) TO authenticated;
GRANT ALL ON FUNCTION public.cancel_order(order_id uuid, reason text) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.cancel_refund_request(refund_request_id uuid, actor_id uuid, provider_confirmed boolean, reason text) TO service_role;
GRANT ALL ON FUNCTION public.capture_payment_intent(payment_intent_id uuid, provider_reference text, idempotency_key text, raw jsonb) TO service_role;
GRANT ALL ON FUNCTION public.claim_expired_stripe_payment_intents(max_intents integer, as_of timestamp with time zone) TO service_role;
GRANT ALL ON FUNCTION public.claim_outbox_events(worker_id text, max_events integer, lease_seconds integer) TO service_role;
GRANT ALL ON FUNCTION public.complete_outbox_event(event_id uuid, worker_id text, succeeded boolean, error_message text) TO service_role;
GRANT ALL ON FUNCTION public.complete_stripe_payment_intent_cancel(payment_intent_id uuid, succeeded boolean, error_code text, provider_status text) TO service_role;
GRANT ALL ON FUNCTION public.create_checkout_quote(items jsonb, idempotency_key text, address jsonb, address_id uuid, shipping_method_id uuid, discount_code text, note text, ttl_seconds integer) TO authenticated;
GRANT ALL ON FUNCTION public.create_fulfillment(order_id uuid, items jsonb, carrier text, tracking_number text, tracking_url text) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.create_fulfillment_v2(order_id uuid, items jsonb, idempotency_key text, carrier text, tracking_number text, tracking_url text) TO authenticated;
GRANT ALL ON FUNCTION public.create_order(items jsonb, address jsonb, address_id uuid, shipping_method_id uuid, discount_code text, note text) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.create_order_from_quote(quote_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.create_order_v2(items jsonb, idempotency_key text, address jsonb, address_id uuid, shipping_method_id uuid, discount_code text, note text) TO authenticated;
GRANT ALL ON FUNCTION public.create_payment_intent(order_id uuid, provider text, idempotency_key text, metadata jsonb) TO service_role;
GRANT ALL ON FUNCTION public.create_payment_intent_for_customer(order_id uuid, customer_id uuid, provider text, idempotency_key text, metadata jsonb) TO service_role;
GRANT ALL ON FUNCTION public.create_refund_request(order_id uuid, actor_id uuid, provider text, idempotency_key text, items jsonb, amount numeric, reason text, restock boolean, metadata jsonb) TO service_role;
GRANT ALL ON FUNCTION public.expire_checkout_quotes(max_quotes integer, as_of timestamp with time zone) TO service_role;
GRANT ALL ON FUNCTION public.get_checkout_quote(quote_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_inventory_availability(variant_id uuid, location_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_order_checkout_quote(order_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_order_fulfillment_balance(order_id uuid) TO authenticated, service_role;
GRANT ALL ON FUNCTION public.get_order_ledger(order_id uuid) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.get_payment_intent_for_customer(payment_intent_id uuid, customer_id uuid, provider text) TO service_role;
GRANT ALL ON FUNCTION public.get_payment_operations(order_id uuid) TO authenticated, service_role;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;
GRANT ALL ON FUNCTION public.handle_user_email_change() TO service_role;
GRANT ALL ON FUNCTION public.ingest_payment_provider_event(provider text, provider_event_id text, source text, event_type text, object_reference text, livemode boolean, occurred_at timestamp with time zone, payload_hash text, data jsonb) TO service_role;
GRANT ALL ON FUNCTION public.is_admin() TO anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.list_pending_provider_refunds(provider text, max_requests integer) TO service_role;
GRANT ALL ON FUNCTION public.mark_order_paid(order_id uuid, provider text, provider_ref text) TO service_role, authenticated;
GRANT ALL ON TABLE public.product_reviews TO anon, service_role;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.product_reviews TO authenticated;
GRANT ALL ON FUNCTION public.moderate_review(review_id uuid, status text) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.normalize_promotion_code() TO service_role;
GRANT ALL ON FUNCTION public.prepare_paypal_capture(payment_intent_id uuid, customer_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.price_checkout(items jsonb, address jsonb, shipping_method_id uuid, discount_code text) TO service_role, anon, authenticated;
GRANT ALL ON FUNCTION public.refund_order(order_id uuid, items jsonb, amount numeric, reason text, restock boolean, provider text) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.refund_order_v2(order_id uuid, idempotency_key text, items jsonb, amount numeric, reason text, restock boolean, provider text) TO authenticated;
GRANT ALL ON FUNCTION public.retry_payment_provider_events(max_events integer) TO service_role;
GRANT ALL ON FUNCTION public.review_edit_requires_moderation() TO service_role;
GRANT ALL ON TABLE public.addresses TO anon, service_role;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.addresses TO authenticated;
GRANT ALL ON FUNCTION public.set_default_address(address_id uuid, make_default boolean) TO authenticated, service_role;
GRANT ALL ON FUNCTION public.set_updated_at() TO service_role;
GRANT ALL ON FUNCTION public.set_user_role(user_id uuid, role text) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.update_order_address(order_id uuid, address jsonb, address_id uuid) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.validate_metafield_value() TO service_role;
GRANT ALL ON FUNCTION public.validate_promotion_params() TO service_role;
GRANT ALL ON TABLE public.categories TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.discount_redemptions TO anon, authenticated, service_role;
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.inventory_movements TO anon, authenticated;
GRANT ALL ON TABLE public.inventory_movements TO service_role;
GRANT ALL ON SEQUENCE public.inventory_movements_id_seq TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.locations TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.metafield_definitions TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.metafields TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.metaobject_definitions TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.metaobjects TO anon, authenticated, service_role;
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.order_events TO anon, authenticated;
GRANT ALL ON TABLE public.order_events TO service_role;
GRANT ALL ON SEQUENCE public.order_events_id_seq TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.order_items TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.order_promotions TO anon, authenticated, service_role;
GRANT ALL ON SEQUENCE public.orders_order_number_seq TO anon, authenticated, service_role;
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.payments TO anon, authenticated;
GRANT ALL ON TABLE public.payments TO service_role;
GRANT ALL ON TABLE public.product_categories TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.product_images TO anon, authenticated, service_role;
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE public.product_variants TO anon, authenticated;
GRANT ALL ON TABLE public.product_variants TO service_role;
GRANT ALL ON TABLE public.products TO anon, authenticated, service_role;
GRANT SELECT ON TABLE public.product_listing TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.product_option_values TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.product_options TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.promotion_targets TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.promotions TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.shipping_methods TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.tax_rates TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.variant_option_values TO anon, authenticated, service_role;
GRANT SELECT (id, order_number, customer_id, email, status, financial_status, fulfillment_status, currency, subtotal, discount_total, shipping_total, tax_total, total, shipping_address, billing_address, shipping_method_id, shipping_method_name, discount_code, customer_note, cancel_reason, cancelled_at, paid_at, completed_at, created_at, updated_at) ON TABLE public.orders TO anon, authenticated;
GRANT UPDATE (admin_note) ON TABLE public.orders TO authenticated;
GRANT UPDATE (full_name, phone) ON TABLE public.profiles TO authenticated;
GRANT UPDATE (rating, title, body) ON TABLE public.product_reviews TO authenticated;
GRANT UPDATE (label, receiver, phone, country, province, city, detail, postal_code) ON TABLE public.addresses TO authenticated;
GRANT SELECT (id, order_id, provider, kind, status, amount, currency, provider_ref, created_at, updated_at) ON TABLE public.payments TO anon, authenticated;
GRANT SELECT (id, product_id, sku, barcode, price, compare_at_price, track_inventory, "position", is_active, created_at, updated_at) ON TABLE public.product_variants TO anon, authenticated;

-- RLS membership predicate: explicitly callable, but only checks the current auth.uid().
grant execute on function public.is_admin() to public;

-- Preserve service-role access to future public objects; clients stay opt-in.
alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
alter default privileges for role postgres in schema public grant all on functions to service_role;

commit;
