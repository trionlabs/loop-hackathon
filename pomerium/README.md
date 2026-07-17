# Pomerium write-guard (Pomerium Zero)

Pomerium is the zero-trust gate in front of the write-server. Every write the
agent makes is routed through it, so policy is enforced per request at the
network layer, outside the model.

## Architecture

```
runner (agent) -[Bearer JWT]-> Pomerium -> write-server 127.0.0.1:8787/mcp -> X / Notion
```

The write-server is the sole holder of X and Notion credentials and binds
loopback, so the proxy is the only external way to reach a write tool.

Two guards, not one:

- Pomerium revokes an entire tool capability BY NAME (`mcp_tool`), at the
  network layer, outside the model.
- The write-server enforces the dynamic rules Pomerium cannot see: approval,
  daily cap, duplicate, embargo, crisis, kill switch. `mcp_tool` matches the
  tool NAME only and cannot read the post text, so Pomerium alone does not make
  the model safe. Say defense-in-depth, not silver bullet.

## Setup (Pomerium Zero)

The container is bootstrapped by a token and pulls all config from the Pomerium
Zero cloud console (console.pomerium.app). Routes and policies are configured
there, not in a local file.

1. Put `POMERIUM_ZERO_TOKEN` in `config/.env` (already done). The cluster domain
   is your Zero namespace, for example `closing-dory-8243.pomerium.app`.
2. Start the write-server: `pnpm mcp:write` (listens on 127.0.0.1:8787).
3. Start Pomerium: `docker compose --env-file ../config/.env up` from this dir.
4. In the Pomerium Zero console, create a route:
   - From: `https://writeguard.<your-namespace>.pomerium.app`
   - To: `http://host.docker.internal:8787/mcp`
   - Enable the MCP server option on the route (mcp: server).
   - Policy allow: your identity (email or group).
   - Policy DENY: `mcp_tool is admin_reset` (put mcp_tool under deny, never
     allow, or it also blocks tools/list and breaks the session).
5. Point the runner at the route: set `WRITEGUARD_URL` to the Pomerium route URL
   and `WRITEGUARD_TOKEN` to a Pomerium service-account JWT (minted in the
   console), which the runner sends as `Authorization: Bearer <jwt>`.

## Demo (the money shot)

Have the agent attempt the reserved `admin_reset` tool. Pomerium denies it
before it reaches the write-server and logs `allow-why-false:
[mcp-tool-unauthorized]`. Narrate: the guardrail is in the proxy, not the
prompt, so the model literally cannot invoke a revoked capability.

## Verify before the demo

- Pomerium MCP support is experimental; confirm the pinned image serves it.
- Confirm a service-account JWT is accepted for `tools/call` on the mcp route.
- Pre-authenticate and cache the token; never run a browser OAuth flow live.
- Record a fallback clip of the deny sequence.
