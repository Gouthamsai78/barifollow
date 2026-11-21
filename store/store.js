/* BariFollow — static store (GitHub Pages)
   Order selection + WhatsApp handoff. No backend required. */

(() => {
  const WHATSAPP_NUMBER = "917877311536";

  const PACKAGES = [
    {
      slug: "followers-5k",
      name: "5,000 followers",
      label: "5K followers",
      quantity: 5000,
      pricePaise: 18000,
      tagline: "Starter — for a fresh page.",
    },
    {
      slug: "followers-10k",
      name: "10,000 followers",
      label: "10K followers",
      quantity: 10000,
      pricePaise: 28000,
      tagline: "The one most people pick.",
    },
    {
      slug: "followers-20k",
      name: "20,000 followers",
      label: "20K followers",
      quantity: 20000,
      pricePaise: 38000,
      tagline: "Momentum for an active page.",
    },
    {
      slug: "followers-50k",
      name: "50,000 followers",
      label: "50K followers",
      quantity: 50000,
      pricePaise: 58000,
      tagline: "Creator scale, filled naturally.",
    },
    {
      slug: "followers-100k",
      name: "100,000 followers",
      label: "100K followers",
      quantity: 100000,
      pricePaise: 78000,
      tagline: "Authority numbers.",
    },
    {
      slug: "followers-500k",
      name: "500,000 followers",
      label: "500K followers",
      quantity: 500000,
      pricePaise: 110000,
      tagline: "Maximum reach, lowest ₹ / 1K.",
    },
    {
      slug: "blue-tick",
      name: "Blue tick — verification",
      label: "Blue tick",
      quantity: 1,
      pricePaise: 66900,
      tagline: "Audit, document kit, submission and follow-up. Meta decides the badge.",
      manual: true,
    },
  ];

  const nf = new Intl.NumberFormat("en-IN");
  const grid = document.getElementById("packageGrid");
  const count = document.getElementById("pkgCount");
  const checkout = document.getElementById("checkout");
  const form = document.getElementById("orderForm");
  const usernameInput = document.getElementById("coUsername");
  const errorBox = document.getElementById("coError");

  const els = {
    name: document.getElementById("coName"),
    tagline: document.getElementById("coTagline"),
    price: document.getElementById("coPrice"),
    summaryName: document.getElementById("coSummaryName"),
    qty: document.getElementById("coQty"),
    total: document.getElementById("coTotal"),
  };

  let selected = null;

  /* ── formatting ───────────────────────────────────────────────────────── */

  function inr(paise) {
    const n = Number(paise || 0) / 100;
    return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }

  function per1k(pkg) {
    if (pkg.manual || pkg.quantity < 100) return null;
    const paise = Math.round((pkg.pricePaise * 1000) / pkg.quantity);
    return "₹" + (paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 1 }) + " / 1K";
  }

  function waLink(message) {
    return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
  }

  function orderMessage(pkg, username) {
    if (pkg.manual) {
      return `Hi BariFollow — I'm interested in the blue tick verification (${inr(
        pkg.pricePaise
      )} lifetime). My Instagram username is @${username}. Please share the next steps and UPI details.`;
    }
    return `Hi BariFollow — I'd like to order the ${pkg.name} package (${inr(
      pkg.pricePaise
    )}). My Instagram username is @${username}. Please share the UPI payment details.`;
  }

  /* ── package cards ────────────────────────────────────────────────────── */

  function card(pkg) {
    const rate = per1k(pkg);
    const fallback = pkg.manual
      ? `Hi BariFollow — I'm interested in blue tick verification (${inr(pkg.pricePaise)} lifetime). My Instagram username is: `
      : `Hi BariFollow — I'd like to order the ${pkg.name} package (${inr(pkg.pricePaise)}). My Instagram username is: `;

    return `<article class="pkg${pkg.manual ? " pkg--tick" : ""}">
      <div class="pkg__top">
        <span class="mono">${pkg.label}</span>
        <span class="pkg__rate">${rate || "lifetime"}</span>
      </div>
      <h3 class="pkg__name">${pkg.name}</h3>
      <div class="pkg__price">${inr(pkg.pricePaise)}<span>one-time</span></div>
      <p class="pkg__note">${pkg.tagline}</p>
      <a class="btn ${pkg.manual ? "btn--lime" : "btn--ghost"} pkg__cta"
         href="${waLink(fallback)}" target="_blank" rel="noopener noreferrer"
         data-buy="${pkg.slug}">${pkg.manual ? "Start verification" : "Order now"}</a>
    </article>`;
  }

  if (grid) {
    grid.innerHTML = PACKAGES.map(card).join("");
    if (count) count.textContent = `${PACKAGES.length} available`;
  }

  /* ── checkout panel ───────────────────────────────────────────────────── */

  function findPackage(slug) {
    return PACKAGES.find((p) => p.slug === slug) || null;
  }

  function updateUrl(slug, mode) {
    const url = new URL(window.location.href);
    if (slug) url.searchParams.set("package", slug);
    else url.searchParams.delete("package");
    const next = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : "");
    if (mode === "push") window.history.pushState({ package: slug || null }, "", next);
    else window.history.replaceState({ package: slug || null }, "", next);
  }

  function showCheckout(pkg, { push = false, scroll = true } = {}) {
    if (!pkg || !checkout) return;

    selected = pkg;
    document.title = `${pkg.name} — BariFollow Store`;

    els.name.textContent = pkg.name;
    els.tagline.textContent = pkg.tagline;
    els.price.textContent = inr(pkg.pricePaise);
    els.summaryName.textContent = pkg.name;
    els.qty.textContent = pkg.manual ? "Verification" : `${nf.format(pkg.quantity)} followers`;
    els.total.textContent = inr(pkg.pricePaise);

    errorBox.hidden = true;
    errorBox.textContent = "";
    checkout.hidden = false;

    updateUrl(pkg.slug, push ? "push" : "replace");

    if (scroll) {
      requestAnimationFrame(() => checkout.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }

  function hideCheckout() {
    selected = null;
    if (!checkout) return;
    checkout.hidden = true;
    document.title = "Store — BariFollow";
    updateUrl(null, "replace");
  }

  grid?.addEventListener("click", (event) => {
    const buy = event.target.closest("[data-buy]");
    if (!buy) return;
    const pkg = findPackage(buy.getAttribute("data-buy"));
    if (!pkg) return;
    event.preventDefault();
    showCheckout(pkg, { push: true });
  });

  document.getElementById("changePackage")?.addEventListener("click", () => {
    hideCheckout();
    document.getElementById("packages")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  /* ── validation + WhatsApp handoff ────────────────────────────────────── */

  function cleanUsername(raw) {
    const value = String(raw || "").trim().replace(/^@+/, "");
    if (!/^[A-Za-z0-9._]{1,30}$/.test(value)) return null;
    if (value.startsWith(".") || value.endsWith(".") || value.includes("..")) return null;
    return value;
  }

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!selected) return;

    const username = cleanUsername(usernameInput.value);
    if (!username) {
      errorBox.textContent =
        "Enter a valid Instagram username — letters, numbers, dots and underscores only.";
      errorBox.hidden = false;
      usernameInput.focus();
      return;
    }

    usernameInput.value = username;
    errorBox.hidden = true;

    const url = waLink(orderMessage(selected, username));
    const win = window.open(url, "_blank", "noopener,noreferrer");
    if (!win) window.location.href = url;
  });

  usernameInput?.addEventListener("input", () => {
    if (!errorBox.hidden) errorBox.hidden = true;
  });

  /* ── deep link + back/forward ─────────────────────────────────────────── */

  function syncFromUrl({ scroll = true } = {}) {
    const slug = new URLSearchParams(window.location.search).get("package");
    const pkg = findPackage(slug);
    if (pkg) showCheckout(pkg, { scroll });
    else hideCheckout();
  }

  window.addEventListener("popstate", () => syncFromUrl({ scroll: false }));

  const initial = findPackage(new URLSearchParams(window.location.search).get("package"));
  if (initial) showCheckout(initial, { scroll: true });
  else document.title = "Store — BariFollow";

  /* ── footer year ──────────────────────────────────────────────────────── */

  const year = document.getElementById("year");
  if (year) year.textContent = new Date().getFullYear();
})();
