---
name: chrome-cdp
description: Interact with local Chrome browser session (only on explicit user approval after being asked to inspect, debug, or interact with a page open in Chrome)
---

# Chrome CDP

Lightweight Chrome DevTools Protocol CLI. Connects directly via WebSocket — no Puppeteer, works with 100+ tabs, instant connection.

## Prerequisites

- Chrome (or Chromium, Brave, Edge, Vivaldi) with remote debugging enabled: open `chrome://inspect/#remote-debugging` and toggle the switch
- Node.js 22+ (uses built-in WebSocket)
- `cdp` on PATH. This repo installs it as `.config/fish/bin/cdp` (a Node script).

## Endpoint configuration

By default the CLI discovers a local browser by reading `DevToolsActivePort` files from common Chrome/Chromium/Brave/Edge/Vivaldi profile locations.

| Variable | Purpose |
|---|---|
| `CDP_WS_URL` | Full browser WebSocket endpoint, e.g. `ws://127.0.0.1:9222/devtools/browser/<id>`. Takes precedence over all file-based discovery. |
| `CDP_HOST` | Host used with `DevToolsActivePort` discovery (default `127.0.0.1`). |
| `CDP_PORT_FILE` | Explicit path to a `DevToolsActivePort` file. |

Per-tab daemons keep the endpoint they started with. After changing `CDP_WS_URL`, `CDP_HOST`, `CDP_PORT_FILE`, or switching browsers/endpoints, run `cdp stop` before issuing page commands again.

## Commands

All commands use `cdp`. The `<target>` is a **unique** targetId prefix from `list`; copy the full prefix shown in the `list` output (for example `6BE827FA`). The CLI rejects ambiguous prefixes.

### List open pages

```bash
cdp list
```

### Take a screenshot

```bash
cdp shot <target> [file]    # default: screenshot-<target>.png in runtime dir
```

Captures the **viewport only**. Scroll first with `eval` if you need content below the fold. Output includes the page's DPR and coordinate conversion hint (see **Coordinates** below).

### Accessibility tree snapshot

```bash
cdp snap <target>
```

### Evaluate JavaScript

```bash
cdp eval <target> <expr>
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`) across multiple `eval` calls when the DOM can change between them (e.g. after clicking Ignore, card indices shift). Collect all data in one `eval` or use stable selectors.

### Other commands

```bash
cdp html    <target> [selector]   # full page or element HTML
cdp nav     <target> <url>         # navigate and wait for load
cdp net     <target>               # resource timing entries
cdp click   <target> <selector>    # click element by CSS selector
cdp clickxy <target> <x> <y>       # click at CSS pixel coords
cdp type    <target> <text>         # Input.insertText at current focus; works in cross-origin iframes unlike eval
cdp loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms between clicks)
cdp evalraw <target> <method> [json]  # raw CDP command passthrough
cdp open    [url]                  # open new tab (each triggers Allow prompt)
cdp stop    [target]               # stop daemon(s)
```

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR. CDP Input events (`clickxy` etc.) take **CSS pixels**.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical Retina (DPR=2): divide screenshot coords by 2.

## Tips

- Prefer `snap --compact` over `html` for page structure.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/`clickxy` to focus first, then `type`.
- Chrome shows an "Allow debugging" modal once per tab on first access. A background daemon keeps the session alive so subsequent commands need no further approval. Daemons auto-exit after 20 minutes of inactivity.
