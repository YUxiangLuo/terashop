<script lang="ts">
  import { onMount } from "svelte";
  import { message, dateTime } from "$lib/api";
  import {
    getReview,
    moderate,
    deleteReview,
    type Review,
    type ReviewStatus,
  } from "$lib/reviews";
  let { id }: { id: string } = $props();
  let review = $state.raw<Review | null>(null),
    busy = $state(false),
    uncertain = $state(false),
    error = $state(""),
    notice = $state(""),
    status = $state<ReviewStatus>("pending"),
    confirmation = $state("");
  let deleteConfirmation = $state("");
  onMount(() => {
    void load();
  });
  async function load() {
    busy = true;
    error = "";
    notice = "";
    try {
      const v = await getReview(id);
      if (!v) throw Error("Review not found.");
      review = v;
      status = v.status;
      confirmation = "";
      deleteConfirmation = "";
      uncertain = false;
    } catch (e) {
      error = message(e);
      uncertain = true;
    } finally {
      busy = false;
    }
  }
  async function change() {
    if (
      !review ||
      confirmation !== `${review.id} ${status}` ||
      status === review.status
    )
      return;
    if (
      status === "approved" &&
      !confirm("Publish this exact full review text?")
    )
      return;
    await mutate(
      () => moderate(review!, status),
      "Moderation submitted. Reload the original review before another mutation.",
    );
  }
  async function remove() {
    if (
      !review ||
      deleteConfirmation !== `DELETE ${review.id}` ||
      !confirm(
        "Permanently delete this exact review revision? Rejection is the reversible option.",
      )
    )
      return;
    await mutate(
      () => deleteReview(review!),
      "Review deleted. Do not reuse its UUID.",
    );
  }
  async function mutate(fn: () => Promise<unknown>, ok: string) {
    if (busy || uncertain) return;
    busy = true;
    error = "";
    try {
      await fn();
      uncertain = true;
      notice = ok;
    } catch (e) {
      uncertain = true;
      error = `${message(e)} Outcome may be unknown. Read the original UUID before any new mutation; do not retry automatically.`;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Review · Tera Admin</title></svelte:head>
<div class="page-heading">
  <div>
    <a href="/reviews">← Reviews</a>
    <h1>Review moderation</h1>
  </div>
  <button onclick={load} disabled={busy}>Reload original review</button>
</div>
{#if error}<p class="notice error" role="alert">{error}</p>{/if}{#if notice}<p
    class="notice"
    role="status"
  >
    {notice}
  </p>{/if}
{#if review}<div class="editor-grid">
    <article class="card">
      <h2>{review.title}</h2>
      <p>{review.rating}/5 · {review.status} · revision {review.revision}</p>
      <p class="break-word" style="white-space: pre-wrap">{review.body}</p>
      <p class="small muted">
        Submitted {dateTime(review.created_at)}. Text above is untrusted plain
        text.
      </p>
      <p>
        <a href={`/products/${review.product_id}`}>Product</a> ·
        <a href={`/customers/${review.customer_id}`}>Customer</a>
      </p>
    </article>
    <section class="card fields">
      <h2>Moderate</h2>
      <select bind:value={status} disabled={busy || uncertain}
        ><option>pending</option><option>approved</option><option
          >rejected</option
        ></select
      ><label
        >Type <code>{review.id} {status}</code><input
          bind:value={confirmation}
        /></label
      ><button
        onclick={change}
        disabled={busy ||
          uncertain ||
          status === review.status ||
          confirmation !== `${review.id} ${status}`}>Set exact status</button
      >
      <h2>Permanent deletion</h2>
      <label
        >Type <code>DELETE {review.id}</code><input
          bind:value={deleteConfirmation}
        /></label
      ><button
        onclick={remove}
        disabled={busy ||
          uncertain ||
          deleteConfirmation !== `DELETE ${review.id}`}
        >Delete exact revision {review.revision}</button
      >
    </section>
  </div>{:else if busy}<p>Loading review…</p>{/if}
