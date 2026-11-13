# live-verify troubleshooting

Read only when the symptom appears.

## The browser will not start

**"Target closed" means the browser, not the app.** On WSL the server otherwise auto-selects the
*Windows* `chrome.exe` under `/mnt/c/`, whose CDP pipe resets the moment it starts
([chrome-devtools-mcp#690](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/690)). So
`.mcp.json` runs the server through `sh -c` and resolves `--executablePath` itself, from the newest
**Linux** Chrome in the puppeteer cache, with `$CHROME_PATH` as an override. The shell does the
expanding because Claude Code passes `${VAR}` in `args` through literally — the server then reports
being unable to find a browser "at `${CHROME_PATH}`", which is the tell. Installing a Linux Chrome
alone does not fix this: without the flag it still reaches for `/mnt/c`.

Getting that binary: `npx puppeteer browsers install chrome` is the documented way and has been seen
to fail silently here (exit 1, no output, empty directories). It still earns its keep, because the
empty directory names the version to fetch — and it must match the version this MCP pins, not
whatever `puppeteer@latest` wants. Grep the installed package for it:
`grep -rhoE "'1[0-9]{2}\.0\.[0-9]{4}\.[0-9]+'" ~/.npm/_npx/*/node_modules/chrome-devtools-mcp`. Then
download `https://storage.googleapis.com/chrome-for-testing-public/<version>/linux64/chrome-linux64.zip`
and unpack into `~/.cache/puppeteer/chrome/linux-<version>/` (`unzip` may be absent; Python's
`zipfile` works, but restore the exec bit it drops). A newly installed browser needs a Claude Code
restart — the running server does not retry.

That binary also drives a quick render check with no MCP at all, which is enough to prove a page
mounts:

```sh
CH=$(ls ~/.cache/puppeteer/chrome/*/chrome-linux64/chrome | head -1)
"$CH" --headless --disable-gpu --virtual-time-budget=8000 --dump-dom http://localhost:8080/some-route
```

## Driving a drag by script

react-grid-layout and dnd-kit both ignore a bare `dispatchEvent`. A `MouseEvent`
needs `cancelable: true`, `view: window` and `buttons: 1`, and the moves need a `requestAnimationFrame`
between them; without all of that the item never gets `react-draggable-dragging` and no save fires,
which reads exactly like a broken feature. dnd-kit's keyboard path announces into the
`aria-live` region — useful to confirm pickup, though driving the *move* step this way has not been
made to work. Prefer asserting on the network log over the rendered position.
