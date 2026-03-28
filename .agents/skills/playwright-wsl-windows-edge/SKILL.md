---
name: playwright-wsl-windows-edge
description: Use this when Codex runs inside WSL but Playwright MCP extension mode must drive Microsoft Edge on the Windows host. Covers the working setup, verification steps, and fallback to an external HTTP MCP daemon when Codex's built-in stdio MCP loader times out.
origin: project
---

# Playwright MCP via Windows Edge from WSL

Use this skill when all of the following are true:

- Codex is running inside WSL.
- The browser that must be driven is Microsoft Edge on the Windows host.
- Playwright MCP must stay in `--extension` mode.

Do not switch to plain browser-launch mode unless the user explicitly changes the requirement.

## Working baseline

The known-good stdio launch shape is:

```bash
npx -y @playwright/mcp@latest \
  --extension \
  --executable-path "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
```

This launch must inherit `PLAYWRIGHT_MCP_EXTENSION_TOKEN` from the user's environment or Codex config.

## Codex config

Treat `~/.codex/config.toml` as user-owned. Do not edit it unless the user explicitly asks.

Your job in this skill is to:

- inspect the current Playwright MCP config,
- tell the user exactly what needs to change when the config is wrong,
- verify whether the current config works,
- give the user the exact command they should run in another terminal when an external daemon is needed.

Keep the token in user config or environment. Do not copy secrets into repo files.

## Verification workflow

When debugging this setup, verify in this order:

1. Confirm the current config still points at Windows Edge under `/mnt/c/.../msedge.exe`.
2. Confirm the token is present in user config or the current environment.
3. Verify the same stdio command outside Codex's built-in MCP manager using the MCP client library.
4. Only if needed, verify a real tool call such as `browser_navigate` to `https://example.com`.

## What to inspect

Check these items first:

- `~/.codex/config.toml` has a Playwright entry.
- The Playwright args include `--extension`.
- The executable path points to Windows Edge:
  `/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`
- `PLAYWRIGHT_MCP_EXTENSION_TOKEN` is present either in config or environment.
- `startup_timeout_sec` is at least `30` if the user is using direct stdio MCP.

If any of these are missing, do not silently change them. Tell the user exactly what is missing and ask them to update it.

## What to tell the user

When the config is wrong or incomplete, give the user a short, direct checklist:

1. Keep Playwright MCP in `--extension` mode.
2. Point `--executable-path` at the Windows host Edge path.
3. Ensure `PLAYWRIGHT_MCP_EXTENSION_TOKEN` is present.
4. Restart Codex after saving the config.

When the config looks correct but Codex still times out, tell the user:

- the Playwright/Edge setup may still be healthy,
- the next step is an out-of-band verification using the MCP client library,
- if that passes, the likely issue is Codex's built-in stdio MCP loader.

Use this harness-level smoke test from the repo root:

```bash
node <<'NODE'
const { Client, StdioClientTransport } = require('playwright-core/lib/mcpBundle');
(async () => {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--extension', '--executable-path', '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
    env: {
      ...process.env,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN,
    },
  });
  const client = new Client({ name: 'codex-debug', version: '0.0.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(JSON.stringify({ count: tools.tools.length }, null, 2));
  await transport.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
NODE
```

If this succeeds but Codex's built-in MCP still times out, the Playwright setup is healthy and the problem is in Codex's MCP loader, not in Edge, the token, or the extension-mode arguments.

## External daemon fallback

When Codex's built-in stdio MCP loader keeps timing out, tell the user to run Playwright MCP as an external HTTP server in another terminal and then update their own `config.toml` to point at that URL.

Give the user this exact command to launch in WSL:

```bash
env PLAYWRIGHT_MCP_EXTENSION_TOKEN="$PLAYWRIGHT_MCP_EXTENSION_TOKEN" \
npx -y @playwright/mcp@latest \
  --extension \
  --executable-path "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --port 9333
```

Then tell the user to change their own user-level Codex config to:

```toml
[mcp_servers.playwright]
url = "http://localhost:9333/mcp"
```

Do not claim this is already done unless you actually verified it in the current session.

This keeps extension mode, but bypasses the built-in stdio loader.

## Actual usage

Once the setup is healthy, use Playwright MCP normally.

Good real-use checks:

- ask Playwright to navigate to `https://example.com`,
- confirm the page title is `Example Domain`,
- confirm a snapshot or tool result comes back.

If these work, the setup is usable.

When reporting success, separate:

- **MCP health**: can connect, list tools, and call a tool.
- **User browser behavior**: Windows Edge opens and the extension handles the request.

## Operational notes

- Prefer Microsoft Edge on the Windows host over WSL-side Chromium when the requirement is to reuse the host browser.
- Avoid leaving test browser sessions or temporary daemons running after verification.
- If the user asks for a reusable setup in another session, give them the exact launch command plus the `url = "http://localhost:9333/mcp"` fallback and make clear that they must update `config.toml` themselves.
