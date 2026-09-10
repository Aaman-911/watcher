# WATCHER Shield

A Chrome extension that warns you when a web page carries hidden text aimed at
an AI.

It reads pages in your browser and **sends nothing anywhere**. There is no
network call in this extension, and `checks/check-extension.sh` fails the build
if one appears.

---

## Installing it

It is not on the Chrome Web Store. You load it from this folder.

1. Open `chrome://extensions` in Chrome (or Edge, Brave, Arc — anything built
   on Chromium).
2. Turn on **Developer mode**, top right.
3. Click **Load unpacked**.
4. Choose the `extension` folder inside this project:
   `/Users/aman/Desktop/Watcher/extension`

That is the whole install. No build step, no `npm install`, nothing to compile.

**To pin it:** click the puzzle-piece icon in the toolbar and pin WATCHER
Shield, so you can see the badge without hunting for it.

---

## Using it

Browse normally. Nothing changes until a page has something on it.

- **No badge** — nothing on this page is aimed at an AI.
- **An amber number** — that many instructions aimed at an AI were found.

Click the icon to see them. For each one you get:

- **what kind of instruction it is** — "instruction to emit a specific word",
  "an exfiltration address", "instruction to conceal itself from the user"
- **where it was hiding** — "painted the same colour as its background
  (contrast ratio 1.00:1)", "hidden with display:none", "carried in the
  aria-label attribute, which is never displayed"
- **the text itself**, quoted exactly

---

## What it looks for

A person reads what the page renders. A language model reading the same page is
handed considerably more. The gap between those two is where this whole class
of attack lives, so the extension collects what the *model* would get:

| Where text can hide | Caught |
|---|---|
| `display:none`, `visibility:hidden` | yes |
| `opacity: 0`, fully transparent colour | yes |
| Text the same colour as its background | yes, by contrast ratio |
| `font-size: 0`, zero-size or clipped elements | yes |
| Pushed off-screen with `text-indent` or position | yes |
| `aria-label`, `alt`, `title`, `placeholder` | yes |
| Visible text that happens to address an AI | yes |

**Two things it deliberately does not flag.** Ordinary low-contrast design —
grey text on white is a readability problem, not an attack, and reporting it
would bury the real findings. And an `aria-label` on its own is normal, correct
accessibility markup: it gets *read*, but it is not counted as something
"hidden from you" unless what it contains is actually an instruction.

---

## What it will never do

- **Send anything anywhere.** No fetch, no XHR, no WebSocket, no beacon.
  Enforced by a check, not by this sentence.
- **Store your browsing.** Findings live in memory for the tab you are on and
  are dropped when you navigate away or close the tab.
- **Click, type, or change a page.** It reads. That is all it does.
- **Call a model.** It costs nothing to run and needs no API key.

Permissions requested: `storage`, plus `<all_urls>` so it can read pages. It
does **not** request the `tabs` permission, so it cannot see your tab list or
your history.

---

## Honest limits

**It matches patterns.** It catches phrasings it was written to catch. Someone
writing an attack in a way nobody anticipated gets past it. It is a smoke
alarm, not a firewall.

**It has barely met the real web.** The detector was tuned against three
synthetic pages written by one person. Pointed at the internet it will produce
false positives — ordinary pages that say "the assistant should…" in normal
prose. Treat an early warning as "worth a look", not as proof of an attack.

**It warns; it does not protect.** If you paste a page into an AI, or use an
AI browsing tool, the hidden text still reaches the model. This tells you it is
there. What you do about it is yours.

---

## Known gaps

- **No icon files yet**, so Chrome shows a generic puzzle piece. The badge and
  the popup work regardless.
- **Not scanned inside iframes** (`all_frames: false`). An injection inside an
  embedded frame is missed today.
- **Some pages cannot be read at all** by any extension: `chrome://` pages, the
  Chrome Web Store, and PDFs. The popup says so rather than showing a
  misleading all-clear.

---

## For developers

`extension/core/detect.mjs` is a **byte-identical copy** of
`src/core/detect.mjs`. The extension loads it by dynamic `import()` from
`web_accessible_resources`, which keeps the project's no-build-step rule at the
cost of a copy. `checks/check-extension.sh` diffs the two and fails if they
drift. After changing the detector:

```bash
cp src/core/detect.mjs extension/core/detect.mjs
```

`extension/core/extract.mjs` is the part unique to the extension. Its pure
logic is unit-tested in `test/extension/`, and `collectPageText` is exercised
against a real rendering engine in `test/integration/shield.test.mjs`, which
injects the actual module source into a page carrying every concealment
technique at once.
