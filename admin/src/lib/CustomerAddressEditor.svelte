<script lang="ts">
  import { untrack } from "svelte";
  import { message } from "./api";
  import {
    createCustomerAddress,
    updateCustomerAddress,
    type CustomerAddress,
    type CustomerDetail,
  } from "./customers";
  let {
    customer,
    address,
    onsaved,
    oncancel,
    onstate,
  }: {
    customer: CustomerDetail;
    address?: CustomerAddress;
    onsaved: (value: CustomerDetail) => void;
    oncancel: () => void;
    onstate: (unsettled: boolean, busy: boolean) => void;
  } = $props();
  const initial = untrack(() => address);
  const addressId = initial?.id ?? crypto.randomUUID();
  let fields = $state({
    label: initial?.label ?? "",
    recipient_name: initial?.recipient_name ?? "",
    phone: initial?.phone ?? "",
    country: initial?.country ?? "",
    region: initial?.region ?? "",
    city: initial?.city ?? "",
    line1: initial?.line1 ?? "",
    line2: initial?.line2 ?? "",
    postal_code: initial?.postal_code ?? "",
  });
  const baseline = JSON.stringify(fields);
  let busy = $state(false),
    uncertain = $state(false),
    error = $state("");
  let dirty = $derived(JSON.stringify(fields) !== baseline);
  $effect(() => onstate(busy || dirty || uncertain, busy));
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || uncertain) return;
    busy = true;
    error = "";
    const changes = {
      label: fields.label,
      recipient_name: fields.recipient_name,
      phone: fields.phone.trim() || null,
      country: fields.country.trim(),
      region: fields.region.trim() || null,
      city: fields.city.trim() || null,
      line1: fields.line1,
      line2: fields.line2.trim() || null,
      postal_code: fields.postal_code.trim() || null,
    };
    try {
      const value = address
        ? await updateCustomerAddress(customer.id, address, changes)
        : await createCustomerAddress(customer.id, addressId, changes);
      onsaved(value);
    } catch (cause) {
      uncertain = true;
      error = `${message(cause)} Reload the customer before another address command; the request may have succeeded.`;
    } finally {
      busy = false;
    }
  }
</script>

<form
  class="card"
  onsubmit={save}
  aria-label={address ? "Edit address" : "New address"}
>
  <h2>{address ? "Edit address" : "New address"}</h2>
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  <fieldset disabled={busy || uncertain}>
    <label>Label<input bind:value={fields.label} /></label>
    <label>Recipient<input required bind:value={fields.recipient_name} /></label
    >
    <label>Phone<input type="tel" bind:value={fields.phone} /></label>
    <label
      >Country code<input
        required
        minlength="2"
        maxlength="2"
        bind:value={fields.country}
      /></label
    >
    <label>Address line 1<input required bind:value={fields.line1} /></label>
    <label>Address line 2<input bind:value={fields.line2} /></label>
    <label>City<input bind:value={fields.city} /></label>
    <label>Region<input bind:value={fields.region} /></label>
    <label>Postal code<input bind:value={fields.postal_code} /></label>
  </fieldset>
  <div class="actions form-action">
    <button type="button" onclick={oncancel} disabled={busy || uncertain}
      >Cancel</button
    ><button class="primary" disabled={busy || uncertain || !dirty}
      >{address ? "Save address" : "Add address"}</button
    >
  </div>
</form>
