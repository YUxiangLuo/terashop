<script lang="ts">
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { supabase, message, imageUrl } from "./api";
  import { watchAdminChanges } from "./realtime";
  import type { Category, CategoryPage } from "./categories";
  import { categoryReceipt } from "./write-receipts";
  let { id, creating }: { id: string; creating: boolean } = $props();
  let category = $state.raw<Category | null>(null);
  let fields = $state({
    name: "",
    slug: "",
    description: "",
    image_url: "",
    position: 0,
    is_active: false,
    parent_id: null as string | null,
  });
  let parentName = $state("");
  let baseline = $state("");
  let loaded = $state(false);
  let busy = $state(false);
  let uncertain = $state(false);
  let error = $state("");
  let notice = $state("");
  let live = $state(false);
  let changes = $state(0),
    checked = $state(0),
    attempted = $state(0);
  let parents = $state<Category[]>([]);
  let parentSearch = $state("");
  let parentCursor = $state<string | null>(null);
  let parentBusy = $state(false);
  let parentError = $state("");
  let applied = "";
  let alive = true;
  let dirty = $derived(loaded && JSON.stringify(fields) !== baseline);
  let back = $derived.by(() => {
    const params = new URLSearchParams();
    for (const key of ["search", "active"]) {
      const value = page.url.searchParams.get(key);
      if (value) params.set(key, value);
    }
    return `/categories${params.size ? `?${params}` : ""}`;
  });
  onMount(() => {
    void load();
    void searchParents(false);
    const stop = watchAdminChanges(
      supabase,
      "categories",
      () => changes++,
      (value) => (live = value),
    );
    return () => {
      alive = false;
      stop();
    };
  });
  $effect(() => {
    if (changes > attempted && !busy && !dirty && !uncertain && !creating)
      void load(true);
  });
  beforeNavigate(({ cancel }) => {
    if (busy || (dirty && !window.confirm("Discard unsaved category edits?")))
      cancel();
  });
  function install(value: Category | null) {
    category = value;
    fields = {
      name: value?.name ?? "",
      slug: value?.slug ?? "",
      description: value?.description ?? "",
      image_url: value?.image_url ?? "",
      position: value?.position ?? 0,
      is_active: value?.is_active ?? false,
      parent_id: value?.parent_id ?? null,
    };
    parentName = value?.parent_id ?? "";
    baseline = JSON.stringify(fields);
    loaded = true;
    uncertain = false;
  }
  async function load(automatic = false) {
    if (busy) return;
    const version = changes;
    attempted = version;
    busy = true;
    error = "";
    if (!automatic) notice = "";
    try {
      const result = await supabase.rpc("get_admin_category", {
        category_id: id,
      });
      if (result.error) throw result.error;
      if (!alive) return;
      const value =
        result.data === null
          ? null
          : (categoryReceipt(result.data, id, null) as unknown as Category);
      if (!value && !creating) throw new Error("Category not found.");
      install(value);
      checked = version;
      if (value?.parent_id) {
        const parent = await supabase.rpc("get_admin_category", {
          category_id: value.parent_id,
        });
        if (alive && !parent.error && parent.data)
          parentName = (parent.data as unknown as Category).name;
      }
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) busy = false;
    }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !loaded || uncertain) return;
    if (
      (fields.is_active !== (category?.is_active ?? false) ||
        fields.parent_id !== (category?.parent_id ?? null)) &&
      !window.confirm(
        "Save category visibility or parent changes? Disabling a category does not disable its children or products. Static storefront pages need a rebuild.",
      )
    )
      return;
    busy = true;
    error = "";
    notice = "";
    try {
      const changes = { ...fields, image_url: fields.image_url || null };
      const result = category
        ? await supabase.rpc("update_category", {
            category_id: id,
            expected_updated_at: category.updated_at,
            changes,
          })
        : await supabase.rpc("create_category", { category_id: id, changes });
      if (result.error) throw result.error;
      if (!alive) return;
      const name = parentName;
      install(
        categoryReceipt(
          result.data,
          id,
          category?.updated_at ?? null,
        ) as unknown as Category,
      );
      parentName = name;
      notice =
        "Category saved. Product assignments are unchanged. Rebuild the static storefront to update its pages.";
    } catch (cause) {
      if (alive) {
        uncertain = true;
        error = `${message(cause)} Reload the saved category before another save; the request may have succeeded.`;
      }
    } finally {
      if (alive) busy = false;
    }
  }
  async function searchParents(more: boolean) {
    if (parentBusy) return;
    parentBusy = true;
    parentError = "";
    if (!more) {
      applied = parentSearch.trim();
      parentCursor = null;
      parents = [];
    }
    try {
      const result = await supabase.rpc("list_admin_categories", {
        page_size: 20,
        ...(applied ? { search: applied } : {}),
        ...(more && parentCursor ? { after_id: parentCursor } : {}),
      });
      if (result.error) throw result.error;
      if (!alive) return;
      const data = result.data as unknown as CategoryPage;
      parents = more
        ? [
            ...parents,
            ...data.items.filter(
              (item) => !parents.some((old) => old.id === item.id),
            ),
          ]
        : data.items;
      parentCursor = data.next_cursor;
    } catch (cause) {
      if (alive) parentError = message(cause);
    } finally {
      if (alive) parentBusy = false;
    }
  }
</script>

<svelte:head
  ><title>{category?.name ?? "New category"} · Tera Admin</title></svelte:head
>
<svelte:window
  onbeforeunload={(event) => {
    if (busy || dirty) event.preventDefault();
  }}
/>
<div class="page-heading">
  <div>
    <a href={back} class="small">← Categories</a>
    <h1>{category?.name ?? (creating ? "New category" : "Category")}</h1>
  </div>
  <div class="actions">
    <button
      disabled={busy}
      onclick={() => {
        if (
          !dirty ||
          window.confirm("Discard local edits and reload the saved category?")
        )
          void load();
      }}>Reload category</button
    ><button
      class="primary"
      form="category-form"
      disabled={busy || !loaded || uncertain || !dirty}>Save category</button
    >
  </div>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}
{#if notice}<p class="notice" role="status">{notice}</p>{/if}
<p class="small muted">
  {live
    ? "Live category updates connected."
    : "Live category updates unavailable; focus or reload to check current facts."}
</p>
{#if changes > checked}<p class="notice" role="status">
    Category data may have changed. Local edits and unconfirmed operations are
    preserved. Reload the category to check current facts.
  </p>{/if}
{#if !loaded}<p role="status">
    {busy ? "Loading category…" : "Unable to open category."}
  </p>{:else}
  <form id="category-form" onsubmit={save}>
    <fieldset disabled={busy || uncertain}>
      <div class="editor-grid">
        <section class="card fields">
          <h2>Category details</h2>
          <label
            >Name<input
              required
              maxlength="200"
              bind:value={fields.name}
            /></label
          >
          <label
            >Slug<input
              required
              maxlength="200"
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              bind:value={fields.slug}
            /></label
          >
          <label
            >Description<textarea
              rows="4"
              maxlength="20000"
              bind:value={fields.description}></textarea></label
          >
          <div class="fields two">
            <label
              >Sibling position<input
                type="number"
                required
                min="-2147483648"
                max="2147483647"
                step="1"
                bind:value={fields.position}
              /></label
            ><label class="check-label"
              ><input type="checkbox" bind:checked={fields.is_active} />Active
              category</label
            >
          </div>
          <p class="small muted">
            Lower positions appear first among siblings. Inactive categories
            keep their product assignments; their children and products are not
            automatically disabled.
          </p>
          <label
            >Image URL<input
              type="url"
              maxlength="2000"
              bind:value={fields.image_url}
              placeholder="https://…"
            /></label
          >
          {#if imageUrl(fields.image_url)}<img
              class="thumbnail"
              src={imageUrl(fields.image_url)}
              alt={fields.name}
            />{/if}
          <p class="small muted">
            URL only; this does not upload a file. Do not use private images.
          </p>
        </section>
        <section class="card">
          <h2>Parent category</h2>
          <p class="break-word">
            {fields.parent_id ? parentName : "Root category"}
          </p>
          <button
            type="button"
            disabled={!fields.parent_id}
            onclick={() => {
              fields.parent_id = null;
              parentName = "";
            }}>Move to root</button
          >
          <p class="small muted">
            Choose an existing category. Cycles are rejected when saving.
            Searching does not change the selected parent.
          </p>
          <label
            >Find parent<input
              type="search"
              maxlength="200"
              bind:value={parentSearch}
              onkeydown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void searchParents(false);
                }
              }}
            /></label
          >
          <button
            class="form-action"
            type="button"
            disabled={parentBusy}
            onclick={() => searchParents(false)}>Search parents</button
          >
          {#if parentError}<p role="alert" class="notice error">
              {parentError}
            </p>{/if}
          {#each parents.filter((item) => item.id !== id) as item (item.id)}<label
              class="check-label"
              ><input
                type="radio"
                name="parent"
                checked={fields.parent_id === item.id}
                onchange={() => {
                  fields.parent_id = item.id;
                  parentName = item.name;
                }}
              /><span class="break-word"
                >{item.name}{item.is_active ? "" : " · Inactive"}<small
                  class="cell-detail">/{item.slug}</small
                ></span
              ></label
            >{/each}
          {#if parentBusy}<p role="status" class="small">
              Loading parents…
            </p>{:else if !parents.length && !parentError}<p
              class="small muted"
            >
              No matching parents.
            </p>{/if}
          {#if parentCursor}<button
              class="form-action"
              type="button"
              disabled={parentBusy}
              onclick={() => searchParents(true)}>More parents</button
            >{/if}
        </section>
      </div>
    </fieldset>
  </form>
{/if}
