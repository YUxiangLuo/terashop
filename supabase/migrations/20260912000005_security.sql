-- Attach invariants and publish the explicit API allowlist only after all functions exist.
begin;

-- Storage is part of the baseline, not seed configuration. Public buckets only
-- bypass read RLS; writes remain restricted by storage.objects policies.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'catalog-media',
  'catalog-media',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storefront view

CREATE VIEW public.product_listing AS
 WITH default_location AS MATERIALIZED (
         SELECT l.id
           FROM public.locations l
          WHERE (l.is_default AND l.is_active)
          ORDER BY l.id
         LIMIT 1
        )
 SELECT id,
    'USD'::text AS currency,
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
          WHERE i.product_id = p.id AND (i.variant_id IS NULL OR EXISTS (
            SELECT 1 FROM public.product_variants v WHERE v.id = i.variant_id AND v.is_active))
          ORDER BY i."position", i.id
         LIMIT 1) AS primary_image,
    ( SELECT array_agg(c.slug ORDER BY c.slug) AS array_agg
           FROM (public.product_categories pc
             JOIN public.categories c ON ((c.id = pc.category_id)))
          WHERE ((pc.product_id = p.id) AND c.is_active)) AS categories,
    COALESCE(( SELECT bool_or(((NOT v.track_inventory) OR ((COALESCE(il.on_hand, 0) - (
             SELECT COALESCE(sum(r.quantity), 0) FROM commerce.inventory_reservations r
             WHERE r.variant_id = v.id AND r.location_id = dl.id AND r.expires_at > now())) > 0))) AS bool_or
           FROM ((public.product_variants v
             LEFT JOIN default_location dl ON (true))
             LEFT JOIN public.inventory_levels il ON (((il.variant_id = v.id) AND (il.location_id = dl.id))))
          WHERE ((v.product_id = p.id) AND v.is_active)), false) AS in_stock
   FROM public.products p
  WHERE (status = 'active'::text);

-- Transaction and audit triggers

CREATE CONSTRAINT TRIGGER order_validation_check AFTER INSERT ON private.order_validation_queue DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_order_totals();

CREATE TRIGGER carts_write BEFORE UPDATE ON commerce.carts FOR EACH ROW EXECUTE FUNCTION private.guard_cart_write();
CREATE TRIGGER cart_lines_write BEFORE INSERT OR UPDATE OR DELETE ON commerce.cart_lines FOR EACH ROW EXECUTE FUNCTION private.guard_cart_write();
CREATE CONSTRAINT TRIGGER carts_lines_check AFTER INSERT OR UPDATE ON commerce.carts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_cart_lines();
CREATE CONSTRAINT TRIGGER cart_lines_check AFTER INSERT OR UPDATE OR DELETE ON commerce.cart_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_cart_lines();
CREATE TRIGGER carts_no_truncate BEFORE TRUNCATE ON commerce.carts FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER cart_lines_no_truncate BEFORE TRUNCATE ON commerce.cart_lines FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();

CREATE TRIGGER checkout_quote_lines_immutable BEFORE DELETE OR UPDATE ON commerce.checkout_quote_lines FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE CONSTRAINT TRIGGER checkout_quote_lines_match_header AFTER INSERT OR DELETE OR UPDATE ON commerce.checkout_quote_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_checkout_quote_totals();
CREATE TRIGGER checkout_quote_lines_no_truncate BEFORE TRUNCATE ON commerce.checkout_quote_lines FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER checkout_quote_lines_reservation_validate AFTER INSERT ON commerce.checkout_quote_lines FOR EACH ROW EXECUTE FUNCTION private.validate_checkout_quote_line_reservation();
CREATE TRIGGER checkout_quotes_reservation_release AFTER UPDATE OF status ON commerce.checkout_quotes FOR EACH ROW EXECUTE FUNCTION private.release_inventory_reservations();
CREATE TRIGGER inventory_reservations_validate BEFORE INSERT OR DELETE ON commerce.inventory_reservations FOR EACH ROW EXECUTE FUNCTION private.validate_inventory_reservation();
CREATE TRIGGER inventory_reservations_no_update BEFORE UPDATE ON commerce.inventory_reservations FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER inventory_reservations_no_truncate BEFORE TRUNCATE ON commerce.inventory_reservations FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER checkout_quotes_enqueue_outbox AFTER INSERT OR UPDATE OF status ON commerce.checkout_quotes FOR EACH ROW EXECUTE FUNCTION private.checkout_quote_to_outbox();
CREATE TRIGGER checkout_quotes_no_truncate BEFORE TRUNCATE ON commerce.checkout_quotes FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE CONSTRAINT TRIGGER checkout_quotes_require_lines AFTER INSERT ON commerce.checkout_quotes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_checkout_quote_totals();
CREATE TRIGGER checkout_quotes_validate BEFORE DELETE OR UPDATE ON commerce.checkout_quotes FOR EACH ROW EXECUTE FUNCTION private.validate_checkout_quote();
CREATE TRIGGER command_idempotency_immutable BEFORE DELETE OR UPDATE ON commerce.command_idempotency FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER command_idempotency_no_truncate BEFORE TRUNCATE ON commerce.command_idempotency FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER zero_value_cancellations_validate BEFORE INSERT ON commerce.zero_value_cancellations FOR EACH ROW EXECUTE FUNCTION private.validate_zero_value_cancellation();
CREATE TRIGGER zero_value_cancellations_apply AFTER INSERT ON commerce.zero_value_cancellations FOR EACH ROW EXECUTE FUNCTION private.apply_zero_value_cancellation();
CREATE TRIGGER zero_value_cancellations_immutable BEFORE UPDATE OR DELETE ON commerce.zero_value_cancellations FOR EACH ROW EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER zero_value_cancellations_no_truncate BEFORE TRUNCATE ON commerce.zero_value_cancellations FOR EACH STATEMENT EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER fulfillment_lines_immutable BEFORE DELETE OR UPDATE ON commerce.fulfillment_lines FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER fulfillment_lines_no_truncate BEFORE TRUNCATE ON commerce.fulfillment_lines FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER fulfillment_lines_validate BEFORE INSERT ON commerce.fulfillment_lines FOR EACH ROW EXECUTE FUNCTION private.validate_fulfillment_line();
CREATE TRIGGER order_adjustments_append_only BEFORE DELETE OR UPDATE ON commerce.order_adjustments FOR EACH ROW EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER order_adjustments_no_truncate BEFORE TRUNCATE ON commerce.order_adjustments FOR EACH STATEMENT EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER outbox_events_no_truncate BEFORE TRUNCATE ON commerce.outbox_events FOR EACH STATEMENT EXECUTE FUNCTION private.protect_outbox_event();
CREATE TRIGGER outbox_events_protect BEFORE DELETE OR UPDATE ON commerce.outbox_events FOR EACH ROW EXECUTE FUNCTION private.protect_outbox_event();
CREATE TRIGGER outbox_redrives_immutable BEFORE DELETE OR UPDATE ON commerce.outbox_redrives FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER outbox_redrives_no_truncate BEFORE TRUNCATE ON commerce.outbox_redrives FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER payment_intents_capture_marker_immutable BEFORE UPDATE OF provider_capture_requested_at ON commerce.payment_intents FOR EACH ROW EXECUTE FUNCTION private.protect_capture_request_marker();
CREATE TRIGGER payment_intents_enqueue_outbox AFTER INSERT OR UPDATE OF status ON commerce.payment_intents FOR EACH ROW EXECUTE FUNCTION private.payment_intent_to_outbox();
CREATE TRIGGER payment_intents_no_delete BEFORE DELETE ON commerce.payment_intents FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER payment_intents_no_truncate BEFORE TRUNCATE ON commerce.payment_intents FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER payment_intents_validate BEFORE INSERT OR UPDATE ON commerce.payment_intents FOR EACH ROW EXECUTE FUNCTION private.validate_payment_intent();
CREATE TRIGGER payment_provider_events_no_delete BEFORE DELETE ON commerce.payment_provider_events FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER payment_provider_events_no_truncate BEFORE TRUNCATE ON commerce.payment_provider_events FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER payment_provider_events_validate BEFORE INSERT OR UPDATE ON commerce.payment_provider_events FOR EACH ROW EXECUTE FUNCTION private.validate_payment_provider_event();
CREATE TRIGGER payment_transactions_async_refund_guard BEFORE INSERT ON commerce.payment_transactions FOR EACH ROW EXECUTE FUNCTION private.prevent_refund_during_async_request();
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
CREATE CONSTRAINT TRIGGER refund_request_lines_match_header AFTER INSERT OR DELETE OR UPDATE ON commerce.refund_request_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_refund_composition();
CREATE TRIGGER refund_request_lines_no_truncate BEFORE TRUNCATE ON commerce.refund_request_lines FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER refund_request_lines_validate BEFORE INSERT ON commerce.refund_request_lines FOR EACH ROW EXECUTE FUNCTION private.validate_refund_request_line();
CREATE TRIGGER refund_requests_enqueue_outbox AFTER INSERT OR UPDATE OF status ON commerce.refund_requests FOR EACH ROW EXECUTE FUNCTION private.refund_request_to_outbox();
CREATE TRIGGER refund_requests_no_delete BEFORE DELETE ON commerce.refund_requests FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER refund_requests_no_truncate BEFORE TRUNCATE ON commerce.refund_requests FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER refund_requests_provider_reversal_guard BEFORE INSERT ON commerce.refund_requests FOR EACH ROW EXECUTE FUNCTION private.prevent_refund_after_provider_reversal();
CREATE CONSTRAINT TRIGGER refund_requests_require_lines AFTER INSERT ON commerce.refund_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_refund_composition();
CREATE TRIGGER returns_validate BEFORE INSERT OR UPDATE ON commerce.returns FOR EACH ROW EXECUTE FUNCTION private.validate_return_fact();
CREATE TRIGGER returns_no_delete BEFORE DELETE OR TRUNCATE ON commerce.returns FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER return_lines_validate BEFORE INSERT ON commerce.return_lines FOR EACH ROW EXECUTE FUNCTION private.validate_return_fact();
CREATE TRIGGER return_lines_immutable BEFORE UPDATE OR DELETE ON commerce.return_lines FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER return_lines_no_truncate BEFORE TRUNCATE ON commerce.return_lines FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER return_receipts_validate BEFORE INSERT ON commerce.return_receipts FOR EACH ROW EXECUTE FUNCTION private.validate_return_fact();
CREATE TRIGGER return_receipts_immutable BEFORE UPDATE OR DELETE ON commerce.return_receipts FOR EACH ROW EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER return_receipts_no_truncate BEFORE TRUNCATE ON commerce.return_receipts FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER return_receipt_lines_validate BEFORE INSERT ON commerce.return_receipt_lines FOR EACH ROW EXECUTE FUNCTION private.validate_return_fact();
CREATE TRIGGER return_receipt_lines_immutable BEFORE UPDATE OR DELETE ON commerce.return_receipt_lines FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER return_receipt_lines_no_truncate BEFORE TRUNCATE ON commerce.return_receipt_lines FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER return_dispositions_validate BEFORE INSERT ON commerce.return_dispositions FOR EACH ROW EXECUTE FUNCTION private.validate_return_fact();
CREATE TRIGGER return_dispositions_immutable BEFORE UPDATE OR DELETE ON commerce.return_dispositions FOR EACH ROW EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER return_dispositions_no_truncate BEFORE TRUNCATE ON commerce.return_dispositions FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE CONSTRAINT TRIGGER returns_facts AFTER INSERT OR UPDATE ON commerce.returns DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_return_facts();
CREATE CONSTRAINT TRIGGER return_lines_facts AFTER INSERT ON commerce.return_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_return_facts();
CREATE CONSTRAINT TRIGGER return_receipts_facts AFTER INSERT ON commerce.return_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_return_facts();
CREATE CONSTRAINT TRIGGER return_receipt_lines_facts AFTER INSERT ON commerce.return_receipt_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_return_facts();
CREATE CONSTRAINT TRIGGER return_dispositions_facts AFTER INSERT ON commerce.return_dispositions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_return_facts();
CREATE CONSTRAINT TRIGGER fulfillments_return_facts AFTER UPDATE ON public.fulfillments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_return_facts();
CREATE TRIGGER returns_event AFTER INSERT OR UPDATE OF status ON commerce.returns FOR EACH ROW EXECUTE FUNCTION private.return_fact_to_outbox();
CREATE TRIGGER return_receipts_event AFTER INSERT ON commerce.return_receipts FOR EACH ROW EXECUTE FUNCTION private.return_fact_to_outbox();
CREATE TRIGGER return_dispositions_event AFTER INSERT ON commerce.return_dispositions FOR EACH ROW EXECUTE FUNCTION private.return_fact_to_outbox();
CREATE TRIGGER refund_lines_restock_cancellation AFTER INSERT ON commerce.refund_lines FOR EACH ROW EXECUTE FUNCTION private.restock_refund_cancellation();
CREATE TRIGGER refund_lines_tax_components AFTER INSERT ON commerce.refund_lines FOR EACH ROW EXECUTE FUNCTION private.refund_line_taxes();
CREATE TRIGGER refund_request_lines_tax_components AFTER INSERT ON commerce.refund_request_lines FOR EACH ROW EXECUTE FUNCTION private.refund_line_taxes();
CREATE TRIGGER refund_components_validate BEFORE INSERT ON commerce.refund_components FOR EACH ROW EXECUTE FUNCTION private.validate_refund_component();
CREATE TRIGGER refund_request_components_validate BEFORE INSERT ON commerce.refund_request_components FOR EACH ROW EXECUTE FUNCTION private.validate_refund_component();
CREATE TRIGGER refund_components_immutable BEFORE UPDATE OR DELETE ON commerce.refund_components FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER refund_request_components_immutable BEFORE UPDATE OR DELETE ON commerce.refund_request_components FOR EACH ROW EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER refund_components_no_truncate BEFORE TRUNCATE ON commerce.refund_components FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER refund_request_components_no_truncate BEFORE TRUNCATE ON commerce.refund_request_components FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE CONSTRAINT TRIGGER refunds_composition AFTER INSERT ON commerce.refunds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_refund_composition();
CREATE CONSTRAINT TRIGGER refund_lines_composition AFTER INSERT ON commerce.refund_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_refund_composition();
CREATE CONSTRAINT TRIGGER refund_components_composition AFTER INSERT ON commerce.refund_components DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_refund_composition();
CREATE CONSTRAINT TRIGGER refund_request_components_composition AFTER INSERT ON commerce.refund_request_components DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_refund_composition();
CREATE TRIGGER refund_requests_validate BEFORE INSERT OR UPDATE ON commerce.refund_requests FOR EACH ROW EXECUTE FUNCTION private.validate_refund_request();
CREATE TRIGGER refunds_append_only BEFORE DELETE OR UPDATE ON commerce.refunds FOR EACH ROW EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER refunds_enqueue_outbox AFTER INSERT ON commerce.refunds FOR EACH ROW EXECUTE FUNCTION private.refund_to_outbox();
CREATE TRIGGER refunds_no_truncate BEFORE TRUNCATE ON commerce.refunds FOR EACH STATEMENT EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER refunds_validate BEFORE INSERT ON commerce.refunds FOR EACH ROW EXECUTE FUNCTION private.validate_refund_header();
CREATE TRIGGER addresses_customer_content BEFORE INSERT OR UPDATE ON public.addresses FOR EACH ROW EXECUTE FUNCTION private.guard_customer_content();
CREATE TRIGGER metafields_customer_content BEFORE INSERT OR UPDATE ON public.metafields FOR EACH ROW EXECUTE FUNCTION private.guard_customer_content();
CREATE TRIGGER carts_customer_content BEFORE INSERT ON commerce.carts FOR EACH ROW EXECUTE FUNCTION private.guard_customer_content();
CREATE TRIGGER addresses_default_command_guard BEFORE UPDATE ON public.addresses FOR EACH ROW EXECUTE FUNCTION private.protect_address_identity_and_default();
CREATE TRIGGER addresses_normalize_country BEFORE INSERT OR UPDATE OF country ON public.addresses FOR EACH ROW EXECUTE FUNCTION private.normalize_address_country();
CREATE TRIGGER addresses_single_default BEFORE INSERT ON public.addresses FOR EACH ROW WHEN (new.is_default) EXECUTE FUNCTION public.enforce_single_default_address();
CREATE TRIGGER addresses_updated_at BEFORE UPDATE ON public.addresses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER categories_updated_at BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER locations_revision BEFORE INSERT OR UPDATE ON public.locations FOR EACH ROW EXECUTE FUNCTION private.bump_location_revision();
CREATE TRIGGER fulfillments_commercial_fields_immutable BEFORE DELETE OR UPDATE ON public.fulfillments FOR EACH ROW EXECUTE FUNCTION private.protect_fulfillment_record();
CREATE TRIGGER fulfillments_no_truncate BEFORE TRUNCATE ON public.fulfillments FOR EACH STATEMENT EXECUTE FUNCTION private.protect_fulfillment_record();
CREATE TRIGGER fulfillments_order_paid BEFORE INSERT ON public.fulfillments FOR EACH ROW EXECUTE FUNCTION private.prevent_unpaid_fulfillment();
CREATE TRIGGER fulfillments_recalculate_order AFTER UPDATE OF status, carrier, tracking_number, tracking_url ON public.fulfillments FOR EACH ROW EXECUTE FUNCTION private.recalculate_order_fulfillment();
CREATE TRIGGER fulfillments_refund_cancellation_guard BEFORE UPDATE OF status ON public.fulfillments FOR EACH ROW EXECUTE FUNCTION private.prevent_refunded_fulfillment_cancellation();
CREATE TRIGGER fulfillments_sync_lines AFTER INSERT ON public.fulfillments FOR EACH ROW EXECUTE FUNCTION private.sync_fulfillment_lines();
CREATE TRIGGER fulfillments_updated_at BEFORE UPDATE ON public.fulfillments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER inventory_levels_reservation_guard BEFORE DELETE OR UPDATE ON public.inventory_levels FOR EACH ROW EXECUTE FUNCTION private.protect_reserved_inventory();
CREATE TRIGGER inventory_movements_append_only BEFORE DELETE OR UPDATE ON public.inventory_movements FOR EACH ROW EXECUTE FUNCTION private.protect_audit_row();
CREATE TRIGGER inventory_movements_no_truncate BEFORE TRUNCATE ON public.inventory_movements FOR EACH STATEMENT EXECUTE FUNCTION private.protect_audit_row();
CREATE CONSTRAINT TRIGGER inventory_transfer_balanced AFTER INSERT ON public.inventory_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_inventory_transfer();
CREATE TRIGGER metafield_definitions_existing_values_compatible BEFORE INSERT OR UPDATE OF owner_type, namespace, key, type, validations ON public.metafield_definitions FOR EACH ROW EXECUTE FUNCTION private.enforce_metafield_definition_compatibility();
CREATE TRIGGER metafield_definitions_updated_at BEFORE UPDATE ON public.metafield_definitions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER metafields_catalog_write BEFORE INSERT OR UPDATE OR DELETE ON public.metafields FOR EACH ROW EXECUTE FUNCTION private.guard_catalog_metafield();
CREATE TRIGGER metafields_definition_integrity BEFORE INSERT OR UPDATE ON public.metafields FOR EACH ROW EXECUTE FUNCTION private.enforce_metafield_integrity();
CREATE TRIGGER metafields_reference_integrity AFTER INSERT OR UPDATE OF type, value ON public.metafields FOR EACH ROW EXECUTE FUNCTION private.sync_metafield_metaobject_refs();
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
CREATE TRIGGER orders_payment_window_immutable BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION private.protect_order_payment_window();
CREATE TRIGGER orders_totals_match AFTER INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION private.schedule_order_totals();
CREATE TRIGGER order_items_totals_match AFTER INSERT OR UPDATE OR DELETE ON public.order_items FOR EACH ROW EXECUTE FUNCTION private.schedule_order_totals();
CREATE TRIGGER shipping_lines_price_guard BEFORE INSERT OR UPDATE OR DELETE ON commerce.order_shipping_lines FOR EACH ROW EXECUTE FUNCTION private.protect_order_pricing();
CREATE TRIGGER tax_lines_price_guard BEFORE INSERT OR UPDATE OR DELETE ON commerce.order_tax_lines FOR EACH ROW EXECUTE FUNCTION private.protect_order_pricing();
CREATE TRIGGER discount_allocations_price_guard BEFORE INSERT OR UPDATE OR DELETE ON commerce.order_discount_allocations FOR EACH ROW EXECUTE FUNCTION private.protect_order_pricing();
CREATE TRIGGER order_promotions_price_guard BEFORE INSERT OR UPDATE OR DELETE ON public.order_promotions FOR EACH ROW EXECUTE FUNCTION private.protect_order_pricing();
CREATE TRIGGER shipping_lines_totals AFTER INSERT OR UPDATE OR DELETE ON commerce.order_shipping_lines FOR EACH ROW EXECUTE FUNCTION private.schedule_order_totals();
CREATE TRIGGER tax_lines_totals AFTER INSERT OR UPDATE OR DELETE ON commerce.order_tax_lines FOR EACH ROW EXECUTE FUNCTION private.schedule_order_totals();
CREATE TRIGGER discount_allocations_totals AFTER INSERT OR UPDATE OR DELETE ON commerce.order_discount_allocations FOR EACH ROW EXECUTE FUNCTION private.schedule_order_totals();
CREATE TRIGGER order_promotions_totals AFTER INSERT OR UPDATE OR DELETE ON public.order_promotions FOR EACH ROW EXECUTE FUNCTION private.schedule_order_totals();
CREATE TRIGGER shipping_lines_no_truncate BEFORE TRUNCATE ON commerce.order_shipping_lines FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER tax_lines_no_truncate BEFORE TRUNCATE ON commerce.order_tax_lines FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER discount_allocations_no_truncate BEFORE TRUNCATE ON commerce.order_discount_allocations FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER order_promotions_no_truncate BEFORE TRUNCATE ON public.order_promotions FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER categories_tree_write BEFORE INSERT OR UPDATE OR DELETE ON public.categories FOR EACH STATEMENT EXECUTE FUNCTION private.guard_category_tree();
CREATE CONSTRAINT TRIGGER categories_tree_check AFTER INSERT OR UPDATE ON public.categories DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_category_tree();
CREATE TRIGGER products_identity BEFORE UPDATE OF id ON public.products FOR EACH ROW EXECUTE FUNCTION private.guard_catalog_product();
CREATE TRIGGER products_revision BEFORE INSERT OR UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION private.advance_catalog_revision();
CREATE TRIGGER product_categories_catalog_write BEFORE INSERT OR UPDATE OR DELETE ON public.product_categories FOR EACH ROW EXECUTE FUNCTION private.guard_catalog_product();
CREATE CONSTRAINT TRIGGER products_catalog_check AFTER INSERT OR UPDATE OF status ON public.products DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_catalog_product();
CREATE TRIGGER product_variants_catalog_write BEFORE INSERT OR DELETE OR UPDATE ON public.product_variants FOR EACH ROW EXECUTE FUNCTION private.guard_catalog_product();
CREATE CONSTRAINT TRIGGER product_variants_catalog_check AFTER INSERT OR DELETE OR UPDATE OF id, product_id, is_active ON public.product_variants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_catalog_product();
CREATE TRIGGER product_options_catalog_write BEFORE INSERT OR UPDATE OR DELETE ON public.product_options FOR EACH ROW EXECUTE FUNCTION private.guard_catalog_product();
CREATE CONSTRAINT TRIGGER product_options_catalog_check AFTER INSERT OR UPDATE OR DELETE ON public.product_options DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_catalog_product();
CREATE TRIGGER product_option_values_catalog_write BEFORE INSERT OR UPDATE OR DELETE ON public.product_option_values FOR EACH ROW EXECUTE FUNCTION private.guard_catalog_product();
CREATE CONSTRAINT TRIGGER product_option_values_catalog_check AFTER INSERT OR UPDATE OR DELETE ON public.product_option_values DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_catalog_product();
CREATE TRIGGER variant_option_values_catalog_write BEFORE INSERT OR UPDATE OR DELETE ON public.variant_option_values FOR EACH ROW EXECUTE FUNCTION private.guard_catalog_product();
CREATE CONSTRAINT TRIGGER variant_option_values_catalog_check AFTER INSERT OR UPDATE OR DELETE ON public.variant_option_values DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_catalog_product();
CREATE TRIGGER product_images_catalog_write BEFORE INSERT OR UPDATE OR DELETE ON public.product_images FOR EACH ROW EXECUTE FUNCTION private.guard_catalog_product();
CREATE CONSTRAINT TRIGGER product_images_catalog_check AFTER INSERT OR UPDATE OR DELETE ON public.product_images DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.assert_catalog_product();
CREATE TRIGGER product_reviews_remoderate BEFORE UPDATE ON public.product_reviews FOR EACH ROW EXECUTE FUNCTION public.review_edit_requires_moderation();
CREATE TRIGGER product_reviews_updated_at BEFORE UPDATE ON public.product_reviews FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER product_variants_updated_at BEFORE UPDATE ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER products_updated_at BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER customers_identity BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION private.protect_customer();
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER customers_no_delete BEFORE DELETE OR TRUNCATE ON public.customers FOR EACH STATEMENT EXECUTE FUNCTION private.protect_immutable_row();
CREATE TRIGGER promotion_targets_scope BEFORE INSERT OR UPDATE OR DELETE ON public.promotion_targets FOR EACH ROW EXECUTE FUNCTION private.guard_promotion_targets();
CREATE TRIGGER promotions_normalize_code BEFORE INSERT OR UPDATE OF code ON public.promotions FOR EACH ROW EXECUTE FUNCTION public.normalize_promotion_code();
CREATE TRIGGER promotions_revision BEFORE INSERT OR UPDATE ON public.promotions FOR EACH ROW EXECUTE FUNCTION private.bump_promotion_revision();
CREATE TRIGGER promotions_updated_at BEFORE UPDATE ON public.promotions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER promotions_validate BEFORE INSERT OR UPDATE ON public.promotions FOR EACH ROW EXECUTE FUNCTION public.validate_promotion_params();
CREATE TRIGGER shipping_methods_normalize_countries BEFORE INSERT OR UPDATE OF countries ON public.shipping_methods FOR EACH ROW EXECUTE FUNCTION private.normalize_shipping_countries();
CREATE TRIGGER shipping_methods_revision BEFORE INSERT OR UPDATE ON public.shipping_methods FOR EACH ROW EXECUTE FUNCTION private.bump_shipping_method_revision();
CREATE TRIGGER shipping_methods_updated_at BEFORE UPDATE ON public.shipping_methods FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER tax_rates_normalize_country BEFORE INSERT OR UPDATE OF country ON public.tax_rates FOR EACH ROW EXECUTE FUNCTION private.normalize_tax_country();
CREATE TRIGGER tax_rates_revision BEFORE INSERT OR UPDATE ON public.tax_rates FOR EACH ROW EXECUTE FUNCTION private.bump_tax_rate_revision();

-- Supabase Auth integration triggers

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();
CREATE TRIGGER on_auth_user_email_updated AFTER UPDATE OF email ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_user_email_change();

-- Row-level policies

CREATE POLICY "customers: read own or admin" ON public.customers FOR SELECT USING (auth_user_id = auth.uid() OR public.is_admin());
CREATE POLICY "catalog media: admin immutable insert" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'catalog-media'
  AND public.is_admin()
  AND name ~ '^products/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
);
CREATE POLICY "customers: update own or admin" ON public.customers FOR UPDATE USING ((auth_user_id = auth.uid() AND anonymized_at IS NULL) OR public.is_admin());
CREATE POLICY "addresses: own all" ON public.addresses USING (((public.current_customer_id() = customer_id) OR public.is_admin()));
CREATE POLICY "categories: admin write" ON public.categories USING (public.is_admin());
CREATE POLICY "categories: public read" ON public.categories FOR SELECT USING ((is_active OR public.is_admin()));
CREATE POLICY "discount_redemptions: read own or admin" ON public.discount_redemptions FOR SELECT USING (((public.current_customer_id() = customer_id) OR public.is_admin()));
CREATE POLICY "fulfillments: read own or admin" ON public.fulfillments FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = fulfillments.order_id) AND ((o.customer_id = public.current_customer_id()) OR public.is_admin())))));
CREATE POLICY "inventory_levels: admin all" ON public.inventory_levels USING (public.is_admin());
CREATE POLICY "inventory_movements: admin read" ON public.inventory_movements FOR SELECT USING (public.is_admin());
CREATE POLICY "locations: admin write" ON public.locations USING (public.is_admin());
CREATE POLICY "locations: public read active" ON public.locations FOR SELECT USING ((is_active OR public.is_admin()));
CREATE POLICY "metafield_definitions: admin write" ON public.metafield_definitions USING (public.is_admin());
CREATE POLICY "metafield_definitions: public read" ON public.metafield_definitions FOR SELECT
  USING (access = 'public' OR (access = 'customer' AND public.current_customer_id() IS NOT NULL));
CREATE POLICY "metafields: admin write" ON public.metafields USING (public.is_admin());
CREATE POLICY "metafields: definition access" ON public.metafields AS RESTRICTIVE FOR SELECT USING (
  public.is_admin() OR (EXISTS (SELECT 1 FROM public.metafield_definitions d
    WHERE (d.owner_type,d.namespace,d.key) = (metafields.owner_type,metafields.namespace,metafields.key)
      AND d.access IN ('public','customer'))
    AND private.metaobject_references_public(type,value)));
CREATE POLICY "metafields: order owner read" ON public.metafields FOR SELECT USING (((owner_type = 'order'::text) AND (EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = metafields.owner_id) AND (o.customer_id = public.current_customer_id()))))));
CREATE POLICY "metafields: scoped read" ON public.metafields FOR SELECT USING ((public.is_admin() OR (owner_type = 'shop'::text) OR ((owner_type = 'customer'::text) AND (owner_id = public.current_customer_id())) OR ((owner_type = 'product'::text) AND (EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = metafields.owner_id) AND (p.status = 'active'::text))))) OR ((owner_type = 'variant'::text) AND (EXISTS ( SELECT 1
   FROM (public.product_variants v
     JOIN public.products p ON ((p.id = v.product_id)))
  WHERE ((v.id = metafields.owner_id) AND v.is_active AND (p.status = 'active'::text))))) OR ((owner_type = 'category'::text) AND (EXISTS ( SELECT 1
   FROM public.categories c
  WHERE ((c.id = metafields.owner_id) AND c.is_active))))));
CREATE POLICY "metaobject_definitions: admin write" ON public.metaobject_definitions USING (public.is_admin());
CREATE POLICY "metaobject_definitions: public read" ON public.metaobject_definitions FOR SELECT USING ((is_active AND access = 'public') OR public.is_admin());
CREATE POLICY "metaobjects: admin write" ON public.metaobjects USING (public.is_admin());
CREATE POLICY "metaobjects: public read active" ON public.metaobjects FOR SELECT USING (
  public.is_admin() OR (status = 'active' AND EXISTS (SELECT 1 FROM public.metaobject_definitions d
    WHERE d.id = metaobjects.definition_id AND d.is_active AND d.access = 'public')));
CREATE POLICY "order_events: read own or admin" ON public.order_events FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = order_events.order_id) AND ((o.customer_id = public.current_customer_id()) OR public.is_admin())))));
CREATE POLICY "order_items: read own or admin" ON public.order_items FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = order_items.order_id) AND ((o.customer_id = public.current_customer_id()) OR public.is_admin())))));
CREATE POLICY "order_promotions: read own or admin" ON public.order_promotions FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = order_promotions.order_id) AND ((o.customer_id = public.current_customer_id()) OR public.is_admin())))));
CREATE POLICY "orders: admin update" ON public.orders FOR UPDATE USING (public.is_admin());
CREATE POLICY "orders: read own or admin" ON public.orders FOR SELECT USING (((public.current_customer_id() = customer_id) OR public.is_admin()));
CREATE POLICY "product_categories: admin write" ON public.product_categories USING (public.is_admin());
CREATE POLICY "product_categories: public read published" ON public.product_categories FOR SELECT USING ((public.is_admin() OR ((EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_categories.product_id) AND (p.status = 'active'::text)))) AND (EXISTS ( SELECT 1
   FROM public.categories c
  WHERE ((c.id = product_categories.category_id) AND c.is_active))))));
CREATE POLICY "product_images: admin write" ON public.product_images USING (public.is_admin());
CREATE POLICY "product_images: public read published" ON public.product_images FOR SELECT USING ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_images.product_id) AND (p.status = 'active'::text)))
  AND (variant_id IS NULL OR EXISTS (SELECT 1 FROM public.product_variants v
    WHERE v.id = product_images.variant_id AND v.is_active)))));
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
CREATE POLICY "product_reviews: customer insert own" ON public.product_reviews FOR INSERT WITH CHECK (((public.current_customer_id() = customer_id) AND (status = 'pending'::text) AND (EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_reviews.product_id) AND (p.status = 'active'::text))))));
CREATE POLICY "product_reviews: customer update own" ON public.product_reviews FOR UPDATE USING ((public.current_customer_id() = customer_id));
CREATE POLICY "product_reviews: public read approved" ON public.product_reviews FOR SELECT USING ((public.is_admin() OR (public.current_customer_id() = customer_id) OR ((status = 'approved'::text) AND (EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_reviews.product_id) AND (p.status = 'active'::text)))))));
CREATE POLICY "product_variants: admin write" ON public.product_variants USING (public.is_admin());
CREATE POLICY "product_variants: public read published" ON public.product_variants FOR SELECT USING ((public.is_admin() OR (is_active AND (EXISTS ( SELECT 1
   FROM public.products p
  WHERE ((p.id = product_variants.product_id) AND (p.status = 'active'::text)))))));
CREATE POLICY "products: admin write" ON public.products USING (public.is_admin());
CREATE POLICY "products: public read active" ON public.products FOR SELECT USING (((status = 'active'::text) OR public.is_admin()));
CREATE POLICY "profiles: read own or admin" ON public.profiles FOR SELECT USING (((auth.uid() = id) OR public.is_admin()));
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

REVOKE ALL ON FUNCTION private.schedule_order_totals(), private.assert_order_totals(), private.guard_promotion_targets() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION private.valid_line_attributes(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.checkout_line_key(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.catalog_product_id(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.guard_catalog_product() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.assert_catalog_product() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.guard_category_tree() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.assert_category_tree() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.active_reserved_quantity(p_variant_id uuid, p_location_id uuid, p_exclude_quote_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.allocate_refund_cancellation() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.allocate_refund_request_cancellation() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.assert_checkout_quote_totals() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.assert_refund_lines_total() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.proportional_refund(numeric,numeric,numeric,numeric,numeric),
  private.refund_component_used(text,uuid,uuid,uuid,uuid), private.item_refund_tax(uuid,integer,uuid,uuid,integer),
  private.plan_refund(uuid,jsonb,numeric,numeric,numeric), private.validate_refund_component(),
  private.refund_components_json(uuid,boolean), private.assert_refund_composition(), private.refund_line_taxes() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.cancel_order(order_id uuid, reason text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.canonical_order_item_quantities(p_items jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.canonical_variant_quantities(p_items jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.canonical_checkout_lines(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.allocate_price_discount(numeric, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.checkout_pricing_hash(p_price jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.checkout_quote_json(p_quote commerce.checkout_quotes) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.checkout_quote_to_outbox() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.command_request_hash(p_request jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.consume_order_reservation(p_order_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.create_fulfillment(order_id uuid, items jsonb, carrier text, tracking_number text, tracking_url text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enforce_metafield_definition_compatibility() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enforce_metafield_integrity() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enqueue_outbox_event(p_aggregate_type text, p_aggregate_id uuid, p_event_type text, p_payload jsonb, p_idempotency_key text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.finalize_refund_request(p_request_id uuid, p_event commerce.payment_provider_events) FROM PUBLIC;
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
REVOKE ALL ON FUNCTION private.prevent_unpaid_fulfillment() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.price_checkout(items jsonb, address jsonb, shipping_method_id uuid, discount_code text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.process_payment_provider_event(p_event_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.process_paypal_payment_event(p_event commerce.payment_provider_events) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.process_paypal_refund_event(p_event commerce.payment_provider_events) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_address_identity_and_default() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_audit_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_capture_request_marker() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_fulfillment_record() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.protect_immutable_row() FROM PUBLIC;
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
REVOKE ALL ON FUNCTION private.provider_payment_intent_json(p_intent commerce.payment_intents) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.recalculate_order_fulfillment() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.record_provider_money_movement(p_event commerce.payment_provider_events, p_kind text, p_amount numeric, p_currency text, p_order_id uuid, p_payment_intent_id uuid, p_refund_request_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refresh_fulfillment_after_refund() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refresh_order_fulfillment(p_order_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refund_order(order_id uuid, items jsonb, amount numeric, reason text, restock boolean, provider text, shipping_amount numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refund_request_json(p_request commerce.refund_requests) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refund_request_to_outbox() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.refund_to_outbox() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.require_consumed_quote_before_payment() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.require_reconciliation(p_movement_id uuid, p_error text, p_order_id uuid, p_payment_intent_id uuid, p_refund_request_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.resolve_checkout_address(p_customer_id uuid, p_address jsonb, p_address_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.set_user_role(user_id uuid, role text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.storefront_order_json(p_order public.orders) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.sync_cancelled_order_quote() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.sync_fulfillment_lines() FROM PUBLIC;
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
REVOKE ALL ON FUNCTION private.capture_refund_available(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.validate_refund_request() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.validate_refund_request_line() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.line_in_scope(jsonb, text, uuid, uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.valid_tax_context(jsonb), private.calculate_checkout_tax(jsonb, jsonb, text),
  private.assert_pricing_breakdown(jsonb), private.order_pricing_json(uuid), private.store_order_tax_lines(uuid, uuid, uuid, jsonb),
  private.store_order_pricing(uuid, jsonb), private.protect_order_pricing(), public.get_order_pricing(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.adjust_inventory(variant_id uuid, delta integer, idempotency_key text, reason text, note text, location_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.anonymize_user(p_user_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_metaobject_exists(p_ref text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_payment_intent_provider(payment_intent_id uuid, provider_reference text, provider_status text, amount numeric, currency text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_refund_request_provider(refund_request_id uuid, provider_reference text, provider_status text, amount numeric, currency text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_checkout_quote(quote_id uuid, reason text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_order(order_id uuid, reason text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_refund_request(refund_request_id uuid, actor_id uuid, provider_confirmed boolean, reason text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capture_payment_intent(payment_intent_id uuid, provider_reference text, idempotency_key text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_outbox_events(worker_id text, max_events integer, lease_seconds integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_outbox_event(event_id uuid, worker_id text, lease_token uuid, succeeded boolean, error_message text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.redrive_outbox_event(uuid,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_admin_outbox_events(integer,text,uuid,text), public.list_admin_payment_provider_events(integer,text,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_checkout_quote(items jsonb, idempotency_key text, address jsonb, address_id uuid, shipping_method_id uuid, discount_code text, note text, ttl_seconds integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_fulfillment(order_id uuid, items jsonb, idempotency_key text, carrier text, tracking_number text, tracking_url text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_fulfillment(uuid,bigint,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_order(items jsonb, idempotency_key text, address jsonb, address_id uuid, shipping_method_id uuid, discount_code text, note text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_order_from_quote(quote_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_payment_intent(order_id uuid, provider text, idempotency_key text, metadata jsonb, payment_method text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_payment_intent_for_customer(order_id uuid, actor_id uuid, provider text, idempotency_key text, metadata jsonb, payment_method text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_refund_request(order_id uuid, actor_id uuid, provider text, idempotency_key text, items jsonb, amount numeric, reason text, restock boolean, metadata jsonb, shipping_amount numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_single_default_address() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_checkout_quotes(max_quotes integer, as_of timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_checkout_quote(quote_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_inventory_availability(variant_id uuid, location_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_order_checkout_quote(order_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_order_fulfillment_balance(order_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_order_ledger(order_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_payment_intent_for_customer(payment_intent_id uuid, actor_id uuid, provider text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_payment_operations(order_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_user_email_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ingest_payment_provider_event(provider text, provider_event_id text, source text, event_type text, object_reference text, livemode boolean, occurred_at timestamp with time zone, payload_hash text, data jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_pending_paypal_captures(max_requests integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_pending_provider_refunds(provider text, max_requests integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_order_paid(order_id uuid, idempotency_key text, provider text, provider_ref text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.moderate_review(review_id uuid, status text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.normalize_promotion_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_paypal_refund(refund_request_id uuid, actor_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_paypal_capture(payment_intent_id uuid, actor_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.price_checkout(items jsonb, address jsonb, shipping_method_id uuid, discount_code text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refund_order(order_id uuid, idempotency_key text, items jsonb, amount numeric, reason text, restock boolean, provider text, shipping_amount numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retry_payment_provider_events(max_events integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_edit_requires_moderation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_default_address(address_id uuid, make_default boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_user_role(user_id uuid, role text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_order_address(order_id uuid, address jsonb, address_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_metafield_value() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_promotion_params() FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.metaobject_references_public(text,jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_storefront_products(integer,uuid,uuid), public.get_storefront_product(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_product(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_product(uuid,bigint,jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_product(uuid,jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_admin_products(integer,text,uuid,text,jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_order(uuid), public.get_customer_order(uuid),
  public.list_admin_orders(integer,bigint,uuid,text,text,text), public.list_customer_orders(integer,bigint,text,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_customer(uuid), public.list_admin_customers(integer,text,boolean,jsonb) TO authenticated, service_role;
GRANT ALL ON FUNCTION private.cancel_order(order_id uuid, reason text) TO service_role;
GRANT ALL ON FUNCTION private.create_fulfillment(order_id uuid, items jsonb, carrier text, tracking_number text, tracking_url text) TO service_role;
GRANT ALL ON FUNCTION private.mark_order_paid(order_id uuid, provider text, provider_ref text) TO service_role;
GRANT ALL ON FUNCTION private.price_checkout(items jsonb, address jsonb, shipping_method_id uuid, discount_code text) TO service_role;
GRANT ALL ON FUNCTION private.refund_order(order_id uuid, items jsonb, amount numeric, reason text, restock boolean, provider text, shipping_amount numeric) TO service_role;
GRANT ALL ON FUNCTION private.set_user_role(user_id uuid, role text) TO service_role;
GRANT ALL ON FUNCTION private.update_order_address(order_id uuid, address jsonb, address_id uuid) TO service_role;
GRANT ALL ON FUNCTION private.valid_country_codes(p_countries text[]) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION private.valid_line_attributes(jsonb), private.checkout_line_key(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION private.valid_tax_context(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_order_pricing(uuid) TO authenticated, service_role;
GRANT ALL ON FUNCTION public.adjust_inventory(variant_id uuid, delta integer, idempotency_key text, reason text, note text, location_id uuid) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.anonymize_user(p_user_id uuid) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.assert_metaobject_exists(p_ref text) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.bind_payment_intent_provider(payment_intent_id uuid, provider_reference text, provider_status text, amount numeric, currency text) TO service_role;
GRANT ALL ON FUNCTION public.bind_refund_request_provider(refund_request_id uuid, provider_reference text, provider_status text, amount numeric, currency text) TO service_role;
GRANT ALL ON FUNCTION public.cancel_checkout_quote(quote_id uuid, reason text) TO authenticated;
GRANT ALL ON FUNCTION public.cancel_order(order_id uuid, reason text) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.cancel_refund_request(refund_request_id uuid, actor_id uuid, provider_confirmed boolean, reason text) TO service_role;
GRANT ALL ON FUNCTION public.capture_payment_intent(payment_intent_id uuid, provider_reference text, idempotency_key text) TO service_role;
GRANT ALL ON FUNCTION public.claim_outbox_events(worker_id text, max_events integer, lease_seconds integer) TO service_role;
GRANT ALL ON FUNCTION public.complete_outbox_event(event_id uuid, worker_id text, lease_token uuid, succeeded boolean, error_message text) TO service_role;
GRANT EXECUTE ON FUNCTION public.redrive_outbox_event(uuid,integer,text,text) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.list_admin_outbox_events(integer,text,uuid,text), public.list_admin_payment_provider_events(integer,text,uuid,jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.create_checkout_quote(items jsonb, idempotency_key text, address jsonb, address_id uuid, shipping_method_id uuid, discount_code text, note text, ttl_seconds integer) TO authenticated;
GRANT ALL ON FUNCTION public.create_fulfillment(order_id uuid, items jsonb, idempotency_key text, carrier text, tracking_number text, tracking_url text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_fulfillment(uuid,bigint,jsonb,text) TO authenticated;
GRANT ALL ON FUNCTION public.create_order(items jsonb, idempotency_key text, address jsonb, address_id uuid, shipping_method_id uuid, discount_code text, note text) TO authenticated;
GRANT ALL ON FUNCTION public.create_order_from_quote(quote_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.create_payment_intent(order_id uuid, provider text, idempotency_key text, metadata jsonb, payment_method text) TO service_role;
GRANT ALL ON FUNCTION public.create_payment_intent_for_customer(order_id uuid, actor_id uuid, provider text, idempotency_key text, metadata jsonb, payment_method text) TO service_role;
GRANT ALL ON FUNCTION public.create_refund_request(order_id uuid, actor_id uuid, provider text, idempotency_key text, items jsonb, amount numeric, reason text, restock boolean, metadata jsonb, shipping_amount numeric) TO service_role;
GRANT ALL ON FUNCTION public.expire_checkout_quotes(max_quotes integer, as_of timestamp with time zone) TO service_role;
GRANT ALL ON FUNCTION public.get_checkout_quote(quote_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_inventory_availability(variant_id uuid, location_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_order_checkout_quote(order_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_order_fulfillment_balance(order_id uuid) TO authenticated, service_role;
GRANT ALL ON FUNCTION public.get_order_ledger(order_id uuid) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.get_payment_intent_for_customer(payment_intent_id uuid, actor_id uuid, provider text) TO service_role;
GRANT ALL ON FUNCTION public.get_payment_operations(order_id uuid) TO authenticated, service_role;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;
GRANT ALL ON FUNCTION public.handle_user_email_change() TO service_role;
GRANT ALL ON FUNCTION public.ingest_payment_provider_event(provider text, provider_event_id text, source text, event_type text, object_reference text, livemode boolean, occurred_at timestamp with time zone, payload_hash text, data jsonb) TO service_role;
GRANT ALL ON FUNCTION public.is_admin() TO anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.list_pending_paypal_captures(max_requests integer) TO service_role;
GRANT ALL ON FUNCTION public.list_pending_provider_refunds(provider text, max_requests integer) TO service_role;
GRANT ALL ON FUNCTION public.mark_order_paid(order_id uuid, idempotency_key text, provider text, provider_ref text) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.moderate_review(review_id uuid, status text) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.normalize_promotion_code() TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_paypal_refund(refund_request_id uuid, actor_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.prepare_paypal_capture(payment_intent_id uuid, actor_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.price_checkout(items jsonb, address jsonb, shipping_method_id uuid, discount_code text) TO service_role, anon, authenticated;
GRANT ALL ON FUNCTION public.refund_order(order_id uuid, idempotency_key text, items jsonb, amount numeric, reason text, restock boolean, provider text, shipping_amount numeric) TO authenticated;
GRANT ALL ON FUNCTION public.retry_payment_provider_events(max_events integer) TO service_role;
GRANT ALL ON FUNCTION public.review_edit_requires_moderation() TO service_role;
GRANT ALL ON FUNCTION public.set_default_address(address_id uuid, make_default boolean) TO authenticated, service_role;
GRANT ALL ON FUNCTION public.set_updated_at() TO service_role;
GRANT ALL ON FUNCTION public.set_user_role(user_id uuid, role text) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.update_order_address(order_id uuid, address jsonb, address_id uuid) TO service_role, authenticated;
GRANT ALL ON FUNCTION public.validate_metafield_value() TO service_role;
GRANT ALL ON FUNCTION public.validate_promotion_params() TO service_role;
REVOKE ALL ON FUNCTION private.lock_order_inventory(uuid[],uuid), private.recover_order_stock(uuid,uuid,integer,uuid,uuid,text),
  private.restock_refund_cancellation(), private.canonical_return_quantities(jsonb,text), private.return_line_received(uuid),
  private.lock_return_command(uuid,text), private.return_json(commerce.returns), private.return_receipt_json(commerce.return_receipts),
  private.return_disposition_json(commerce.return_dispositions), private.validate_return_fact(), private.assert_return_facts(),
  private.return_fact_to_outbox() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_return(uuid,jsonb,text,text), public.receive_return(uuid,uuid,jsonb,text,text),
  public.dispose_return_receipt(uuid,integer,text,text,text), public.close_return(uuid,boolean), public.get_order_returns(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_return(uuid,jsonb,text,text), public.receive_return(uuid,uuid,jsonb,text,text),
  public.dispose_return_receipt(uuid,integer,text,text,text), public.close_return(uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_returns(uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.cancel_zero_value_order_item(uuid,uuid,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_zero_value_order_item(uuid,uuid,integer,text,text) TO authenticated,service_role;

-- Existing objects also use least privilege; clients cannot TRUNCATE, attach triggers or advance sequences.
GRANT ALL ON TABLE public.categories, public.locations, public.metafield_definitions, public.metafields, public.metaobject_definitions, public.metaobjects, public.product_categories, public.product_images, public.products, public.product_option_values, public.product_options, public.promotion_targets, public.promotions, public.shipping_methods, public.tax_rates, public.variant_option_values, public.addresses, public.profiles, public.product_reviews, public.discount_redemptions, public.inventory_levels, public.inventory_movements, public.fulfillments, public.order_events, public.order_items, public.order_promotions, public.product_listing, public.orders, public.product_variants TO service_role;
GRANT ALL ON SEQUENCE public.inventory_movements_id_seq, public.order_events_id_seq, public.orders_order_number_seq TO service_role;
GRANT SELECT ON TABLE public.categories, public.locations, public.metafield_definitions, public.metafields, public.metaobject_definitions, public.metaobjects, public.product_categories, public.product_images, public.products, public.product_option_values, public.product_options, public.promotion_targets, public.promotions, public.shipping_methods, public.tax_rates, public.variant_option_values, public.addresses, public.profiles, public.product_reviews, public.discount_redemptions, public.inventory_levels, public.inventory_movements, public.fulfillments, public.order_events, public.order_items, public.order_promotions, public.product_listing TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.categories, public.locations, public.metafield_definitions, public.metafields, public.metaobject_definitions, public.metaobjects, public.product_categories, public.product_images, public.products, public.product_option_values, public.product_options, public.promotion_targets, public.promotions, public.shipping_methods, public.tax_rates, public.variant_option_values, public.product_variants TO authenticated;
GRANT INSERT, DELETE ON TABLE public.addresses, public.product_reviews TO authenticated;
GRANT SELECT (id, order_number, customer_id, email, status, financial_status, fulfillment_status, currency, subtotal, discount_total, shipping_total, tax_total, total, tax_context, shipping_address, billing_address, shipping_method_id, shipping_method_name, discount_code, customer_note, cancel_reason, cancelled_at, paid_at, payment_expires_at, completed_at, created_at, updated_at) ON TABLE public.orders TO anon, authenticated;
GRANT UPDATE (admin_note) ON TABLE public.orders TO authenticated;
REVOKE ALL ON FUNCTION private.customer_for_user(uuid), private.require_customer(), private.protect_customer(), private.anonymize_customer(uuid),
  private.lock_customer_content(uuid,boolean), private.guard_customer_content() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_customer_id(), public.create_customer(text,text,text,text), public.anonymize_customer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_customer_id() TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.cart_json(commerce.carts), private.access_cart(uuid,text), private.assert_cart_capacity(uuid),
  private.guard_cart_write(), private.assert_cart_lines() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_cart(text,integer), public.get_cart(uuid,text), public.list_carts(),
  public.update_cart(uuid,integer,jsonb,jsonb,uuid,text,text,text), public.claim_cart(uuid,integer,text),
  public.abandon_cart(uuid,integer,text), public.preview_cart(uuid,text), public.checkout_cart(uuid,integer),
  public.purge_expired_carts(integer,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_cart(text,integer), public.get_cart(uuid,text),
  public.update_cart(uuid,integer,jsonb,jsonb,uuid,text,text,text), public.abandon_cart(uuid,integer,text), public.preview_cart(uuid,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_carts(), public.claim_cart(uuid,integer,text), public.checkout_cart(uuid,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_carts(integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_customer(text,text,text,text), public.anonymize_customer(uuid) TO authenticated, service_role;
GRANT SELECT ON public.customers TO authenticated, service_role;
GRANT UPDATE (email, full_name, phone) ON public.customers TO authenticated, service_role;
GRANT UPDATE (rating, title, body) ON TABLE public.product_reviews TO authenticated;
GRANT UPDATE (label, recipient_name, phone, country, region, city, line1, line2, postal_code) ON TABLE public.addresses TO authenticated;
GRANT SELECT (id, product_id, sku, barcode, price, compare_at_price, track_inventory, "position", is_active, created_at, updated_at) ON TABLE public.product_variants TO anon, authenticated;

-- RLS membership predicate: explicitly callable, but only checks the current auth.uid().
grant execute on function public.is_admin() to public;

REVOKE ALL ON FUNCTION private.admin_category_json(public.categories) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_admin_category(uuid),
  public.list_admin_categories(integer,uuid,uuid,boolean,boolean,text),
  public.create_category(uuid,jsonb), public.update_category(uuid,timestamptz,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_category(uuid),
  public.list_admin_categories(integer,uuid,uuid,boolean,boolean,text),
  public.create_category(uuid,jsonb), public.update_category(uuid,timestamptz,jsonb) TO authenticated,service_role;

REVOKE ALL ON FUNCTION public.update_customer(uuid,timestamptz,jsonb),
  public.create_customer_address(uuid,uuid,jsonb), public.update_customer_address(uuid,uuid,timestamptz,jsonb),
  public.delete_customer_address(uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_customer(uuid,timestamptz,jsonb),
  public.create_customer_address(uuid,uuid,jsonb), public.update_customer_address(uuid,uuid,timestamptz,jsonb),
  public.delete_customer_address(uuid,uuid,timestamptz) TO authenticated,service_role;

REVOKE ALL ON FUNCTION private.admin_location_json(public.locations) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_admin_location(uuid), public.list_admin_locations(integer,uuid,boolean,text),
  public.list_admin_inventory_movements(integer,text,uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_location(uuid), public.list_admin_locations(integer,uuid,boolean,text),
  public.list_admin_inventory_movements(integer,text,uuid,uuid,uuid,text) TO authenticated,service_role;

REVOKE ALL ON FUNCTION private.bump_location_revision() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_location(uuid,jsonb), public.update_location(uuid,integer,jsonb),
  public.set_default_location(uuid,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_location(uuid,jsonb), public.update_location(uuid,integer,jsonb),
  public.set_default_location(uuid,integer,uuid) TO authenticated,service_role;

REVOKE ALL ON FUNCTION private.assert_inventory_transfer(), public.get_inventory_transfer(uuid),
  public.transfer_inventory(uuid,uuid,uuid,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_inventory_transfer(uuid),
  public.transfer_inventory(uuid,uuid,uuid,integer,text,text) TO authenticated;

REVOKE ALL ON FUNCTION private.admin_promotion_json(public.promotions), public.get_admin_promotion(uuid),
  public.list_admin_promotions(integer,uuid,boolean,text,boolean,text),
  public.list_admin_promotion_targets(uuid,integer,uuid,text),
  public.list_admin_discount_redemptions(uuid,integer,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_promotion(uuid),
  public.list_admin_promotions(integer,uuid,boolean,text,boolean,text),
  public.list_admin_promotion_targets(uuid,integer,uuid,text),
  public.list_admin_discount_redemptions(uuid,integer,uuid,uuid,uuid) TO authenticated,service_role;

REVOKE ALL ON FUNCTION private.bump_promotion_revision(), public.create_promotion(uuid,jsonb),
  public.update_promotion(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_promotion(uuid,jsonb),
  public.update_promotion(uuid,integer,jsonb) TO authenticated,service_role;

REVOKE ALL ON FUNCTION private.bump_shipping_method_revision(),
  private.admin_shipping_method_json(public.shipping_methods), public.get_admin_shipping_method(uuid),
  public.list_admin_shipping_methods(integer,uuid,boolean,text,text),
  public.create_shipping_method(uuid,jsonb), public.update_shipping_method(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_shipping_method(uuid),
  public.list_admin_shipping_methods(integer,uuid,boolean,text,text),
  public.create_shipping_method(uuid,jsonb), public.update_shipping_method(uuid,integer,jsonb) TO authenticated,service_role;

REVOKE ALL ON FUNCTION private.bump_tax_rate_revision(), private.admin_tax_rate_json(public.tax_rates),
  public.get_admin_tax_rate(uuid), public.list_admin_tax_rates(integer,uuid,boolean,text,text),
  public.create_tax_rate(uuid,jsonb), public.update_tax_rate(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_tax_rate(uuid), public.list_admin_tax_rates(integer,uuid,boolean,text,text),
  public.create_tax_rate(uuid,jsonb), public.update_tax_rate(uuid,integer,jsonb) TO authenticated,service_role;

REVOKE ALL ON FUNCTION private.admin_metafield_definition_json(public.metafield_definitions),
  public.get_admin_metafield_definition(uuid), public.list_admin_metafield_definitions(integer,uuid,text,text,text),
  public.list_admin_metafields(text,uuid,integer,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_admin_metafield_definition(uuid),
  public.list_admin_metafield_definitions(integer,uuid,text,text,text),
  public.list_admin_metafields(text,uuid,integer,uuid,text,text) TO authenticated,service_role;

-- Preserve service-role access to future public objects; clients stay opt-in.
alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
alter default privileges for role postgres in schema public grant all on functions to service_role;

commit;
