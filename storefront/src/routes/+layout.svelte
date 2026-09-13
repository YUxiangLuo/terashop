<script lang="ts">
  import { resolve } from "$app/paths";
  import "../style.css";
  let { data, children } = $props();
</script>

<a class="skip" href="#main">Skip to content</a>
<div class="announcement">
  A considered wardrobe, for every day. <span>All prices in USD</span>
</div>
<header class="header">
  <a class="wordmark" href={resolve("/")} aria-label="Atelier Tera home"
    >ATELIER <i>TERA</i></a
  >
  <nav aria-label="Main navigation">
    <a href={resolve("/shop/")}>Shop all</a>
    {#each data.categories.filter((category) => category.parent_id) as category (category.id)}
      <a href={resolve("/collections/[slug]", { slug: category.slug })}
        >{category.name}</a
      >
    {/each}
  </nav>
  <a class="bag-link" href={resolve("/bag/")}
    >Bag <span aria-hidden="true">↗</span></a
  >
</header>
<main id="main">{@render children()}</main>
<footer>
  <div>
    <a class="wordmark" href={resolve("/")}>ATELIER <i>TERA</i></a>
    <p>Less, but considered.<br />Pieces to make your own.</p>
  </div>
  <div>
    <a href={resolve("/shop/")}>Explore the collection</a><a
      href={resolve("/bag/")}>Your shopping bag</a
    >
    <p>
      Atelier Tera · Sample collection<br />Photography is illustrative.
      Payments are not yet enabled.
    </p>
  </div>
</footer>
