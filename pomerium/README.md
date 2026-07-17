# Pomerium write-guard

Pomerium is the zero-trust gate in front of the write-server. Every write the
agent makes is routed through it, so policy is enforced per request at the
network layer, outside the model.

## How it fits

```
runner (agent) -[Bearer JWT]-> Pomerium -> mcp-write-server :8787/mcp -> X / Notion
```

The runner points its `writeguard` MCP server at the Pomerium route URL
(`WRITEGUARD_URL`) as `type: "http"`, not at the local port. The write-server
binds loopback, so the proxy is the only external way in.

Two guards, not one:

- Pomerium revokes an entire tool capability by name (`mcp_tool`), at the
  network layer, outside the model.
- In-process PreToolUse hooks enforce the dynamic rules Pomerium cannot see:
  daily cap, duplicate, embargo, crisis, kill switch. `mcp_tool` matches the
  tool NAME only and cannot read the post text, so do not claim Pomerium alone
  makes the model safe.

## Setup

1. Create a Pomerium Zero account (free tier) for the hosted authenticate
   service, so no self-hosted IdP is needed.
2. Fill `config.yaml`: generate `shared_secret` and `cookie_secret`
   (`head -c 32 /dev/urandom | base64`), set your domain in the allow policy,
   and set the route `from` hostname.
3. Mint a service-account JWT for the agent and set it as `WRITEGUARD_TOKEN` in
   the runner env; the runner sends it as `Authorization: Bearer <jwt>`.
4. Start the write-server (`pnpm mcp:write`), then `docker compose up`.

## Demo (the money shot)

Have the agent attempt the reserved `admin_reset` tool. Pomerium denies it
before it reaches the write-server and logs `allow-why-false:
[mcp-tool-unauthorized]`. Narrate: the guardrail is in the proxy, not the
prompt, so the model literally cannot invoke a revoked capability.

## Verify before the demo

- The Pomerium build ships the flag-gated MCP capability.
- A service-account JWT is accepted for `tools/call` on an `mcp: server: {}`
  route, and the exact bearer prefix.
- Pre-authenticate and cache the token; never run a browser OAuth flow live.
- Record a fallback clip of the deny sequence in case the live flag misbehaves.
