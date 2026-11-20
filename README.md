# BariFollow — Instagram growth landing page

A single-page site built from the price-list and before/after screenshots in this folder.
No build step, no dependencies — plain HTML, CSS and JS.

## Run it

```bash
cd ~/Desktop/saas/instagram
python3 -m http.server 4173
```

Open http://localhost:4173

Or just double-click `index.html` — it works from the filesystem too.

## Before you publish — 3 things to change

1. **WhatsApp number** — `script.js`, first line:

   ```js
   const WHATSAPP_NUMBER = "919000000000"; // ← REPLACE
   ```

   Country code + number, digits only (e.g. `919876543210`). Every order button,
   the nav CTA, the mobile bar and the menu use this one constant.

2. **Confirm the policies written in copy** — the FAQ and the "Every order
   includes" card mention refill support and refunds before delivery. Edit
   `index.html` (search for "refill" / "refundable") if your terms differ.

3. **Blue tick wording** — the page says the badge is Meta's decision and that
   approval can't be guaranteed. Keep that line; it protects you. Adjust the
   process description if you don't handle documents yourself.

Prices and packages match the price-list screenshot exactly:

| Package        | Price  | Per 1K |
| -------------- | ------ | ------ |
| 5K followers   | ₹180   | ₹36    |
| 10K followers  | ₹280   | ₹28    |
| 20K followers  | ₹380   | ₹19    |
| 50K followers  | ₹580   | ₹11.6  |
| 100K followers | ₹780   | ₹7.8   |
| 500K followers | ₹1,100 | ₹2.2   |
| Blue tick      | ₹669   | lifetime |

To change a price, edit it in **two** places in `index.html`: the visible
`board__price` and the `data-wa` message on the same row.

## Deploy

The folder is static, so any host works:

- **Netlify / Vercel** — drag the folder in, or connect the folder as a project.
  No build command, publish directory `/`.
- **GitHub Pages** — push the folder, enable Pages on the branch root.
- **cPanel / Hostinger** — upload `index.html`, `styles.css`, `script.js` and
  `assets/` to `public_html`.

All asset paths are relative, so it also works from a subfolder.

## Structure

```
index.html        markup + all copy
styles.css        design system, layout, responsive rules
script.js         WhatsApp links, nav, accordion, scroll reveals
assets/           renamed proof screenshots
  proof-model.jpg
  proof-creator.jpg
  proof-barber.jpg
  proof-brand.jpg
  proof-astrologer.jpg
  proof-personal.jpg
  proof-queen.jpg
  proof-newpage.jpg
```

The original `WhatsApp Image…jpeg` files in the folder root are untouched.

## Notes

- Proof cards use `object-fit: contain` so no counts are cropped; the screenshots'
  black backgrounds make the letterboxing invisible.
- Scroll animations respect `prefers-reduced-motion`.
- The page is not affiliated with Instagram/Meta — the footer says so.
- Fonts load from Google Fonts (Instrument Serif, Inter Tight, JetBrains Mono).
  Offline, it falls back to system serif/sans/mono.
