/* BariFollow — small storefront interactions */

(() => {
  /* Copy buttons (UPI ID, etc.) */
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy]");
    if (!button) return;

    const value = button.getAttribute("data-copy") || "";
    const original = button.textContent;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const input = document.createElement("textarea");
        input.value = value;
        input.setAttribute("readonly", "");
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    setTimeout(() => {
      button.textContent = original;
    }, 1600);
  });

  /* Keep the UPI deep link's amount in sync with the form */
  const amount = document.getElementById("topupAmount");
  const upiLink = document.querySelector("[data-upi]");
  if (amount && upiLink) {
    const base = upiLink.getAttribute("href").split("&am=")[0];
    const sync = () => {
      const value = Number(amount.value);
      upiLink.setAttribute(
        "href",
        value > 0 ? `${base}&am=${encodeURIComponent(value.toFixed(2))}` : base
      );
    };
    amount.addEventListener("input", sync);
    sync();
  }
})();
