/* ==========================================================================
   BariFollow — interactions
   ──────────────────────────────────────────────────────────────────────────
   ▸ Change the WhatsApp number on the next line (country code + number,
     digits only, no + or spaces). Everything on the page uses it.
   ========================================================================== */

const WHATSAPP_NUMBER = "917877311536";

const MESSAGES = {
  general: "Hi BariFollow — I'd like to grow my Instagram. Can you share the details?",
  custom:  "Hi BariFollow — I need a custom follower package. My target is: ",
  question:"Hi BariFollow — I have a question before ordering: ",
};

/* ── WhatsApp links ─────────────────────────────────────────────────────── */

const waHref = (message) =>
  `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;

document.querySelectorAll("[data-wa]").forEach((el) => {
  const key = el.getAttribute("data-wa");
  let message;

  if (key === "general" || key === "custom" || key === "question") {
    message = MESSAGES[key];
  } else if (key.startsWith("blue tick")) {
    message = `Hi BariFollow — I'm interested in the ${key}. My Instagram username is: `;
  } else {
    message = `Hi BariFollow — I'd like to order: ${key}. My Instagram username is: `;
  }

  el.setAttribute("href", waHref(message));
  el.setAttribute("target", "_blank");
  el.setAttribute("rel", "noopener noreferrer");
});

/* ── store links ────────────────────────────────────────────────────────── */
/* Default target is the static store in ./store (GitHub Pages). When the
   landing page is served by the optional Node backend, /store/config.js
   defines window.BF_STORE_BASE and these links point at the server-rendered
   checkout instead. */

const BACKEND_STORE = String(window.BF_STORE_BASE || "").replace(/\/+$/, "");
const STORE_BASE = BACKEND_STORE || "store";

document.querySelectorAll("[data-store]").forEach((el) => {
  const key = el.getAttribute("data-store");
  const href =
    key === "home"
      ? `${STORE_BASE}/`
      : BACKEND_STORE
        ? `${STORE_BASE}/checkout?package=${encodeURIComponent(key)}`
        : `${STORE_BASE}/?package=${encodeURIComponent(key)}`;

  el.setAttribute("href", href);
  el.removeAttribute("target");
  el.removeAttribute("rel");
});

document.documentElement.classList.add("has-store");

/* ── sticky nav + scroll progress ───────────────────────────────────────── */

const nav = document.getElementById("nav");
const progress = document.getElementById("progress");
let ticking = false;

function onScroll() {
  const y = window.scrollY;
  nav.classList.toggle("is-stuck", y > 8);

  const max = document.documentElement.scrollHeight - window.innerHeight;
  progress.style.transform = `scaleX(${max > 0 ? Math.min(y / max, 1) : 0})`;

  ticking = false;
}

window.addEventListener(
  "scroll",
  () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(onScroll);
    }
  },
  { passive: true }
);
onScroll();

/* ── mobile sheet ───────────────────────────────────────────────────────── */

const burger = document.getElementById("burger");
const sheet = document.getElementById("sheet");
const sheetClose = document.getElementById("sheetClose");
const sheetCta = sheet.querySelector(".sheet__cta");
const sheetLinks = sheet.querySelectorAll(".sheet__links a");

function openSheet() {
  sheet.classList.add("is-open");
  sheet.setAttribute("aria-hidden", "false");
  burger.setAttribute("aria-expanded", "true");
  burger.setAttribute("aria-label", "Close menu");
  document.body.style.overflow = "hidden";
  sheetClose.focus({ preventScroll: true });
}

function closeSheet({ restoreFocus = true } = {}) {
  sheet.classList.remove("is-open");
  sheet.setAttribute("aria-hidden", "true");
  burger.setAttribute("aria-expanded", "false");
  burger.setAttribute("aria-label", "Open menu");
  document.body.style.overflow = "";
  if (restoreFocus) burger.focus({ preventScroll: true });
}

burger.addEventListener("click", () => {
  sheet.classList.contains("is-open") ? closeSheet() : openSheet();
});
sheetClose.addEventListener("click", () => closeSheet());
sheetCta.addEventListener("click", () => closeSheet({ restoreFocus: false }));
sheetLinks.forEach((a) => a.addEventListener("click", () => closeSheet({ restoreFocus: false })));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sheet.classList.contains("is-open")) closeSheet();
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 900 && sheet.classList.contains("is-open")) {
    closeSheet({ restoreFocus: false });
  }
});

/* ── FAQ accordion ──────────────────────────────────────────────────────── */

document.querySelectorAll(".acc__btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const panel = document.getElementById(btn.getAttribute("aria-controls"));
    const isOpen = btn.getAttribute("aria-expanded") === "true";

    // close the rest
    document.querySelectorAll(".acc__btn").forEach((other) => {
      if (other === btn) return;
      other.setAttribute("aria-expanded", "false");
      const otherPanel = document.getElementById(other.getAttribute("aria-controls"));
      otherPanel.classList.remove("is-open");
    });

    btn.setAttribute("aria-expanded", String(!isOpen));
    panel.classList.toggle("is-open", !isOpen);
  });
});

/* ── reveal on scroll ───────────────────────────────────────────────────── */

const revealables = document.querySelectorAll("[data-reveal]");

if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
  );
  revealables.forEach((el) => io.observe(el));
} else {
  revealables.forEach((el) => el.classList.add("is-in"));
}

/* ── year ───────────────────────────────────────────────────────────────── */

document.getElementById("year").textContent = new Date().getFullYear();
