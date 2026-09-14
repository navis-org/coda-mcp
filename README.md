# coda-mcp

Remote MCP server for authoring [Coda](https://coda.science) workflows. Tools edit a draft graph,
check it against Coda's node definitions, and return a link that opens it in Coda. Nothing is
executed server-side.

Pre-release: requires a Coda deploy that publishes `mcp/v1/coda.js`.

## Connect

Add a remote MCP server (custom connector) with URL `https://<host>/mcp`.

## Tools

| Tool | |
| ---- | - |
| `coda_guide` | plan rules + node catalogue (`detail`: `lean`\|`full`) |
| `coda_node_details` | one node type: full catalogue entry + help document |
| `coda_new_draft` | reset the draft (undoable) |
| `coda_apply_plan` | atomic plan: `add`, `setParams`, `connect`, `disconnect`, `remove` |
| `coda_describe_draft` | node ids, carried columns, set params, wires, issues |
| `coda_check_draft` | edit-time issues |
| `coda_undo` | revert last edit |
| `coda_get_link` | short link; `full_link` for the packed link, `include_json` for the `.coda.json` |

## Endpoints

| Path | |
| ---- | - |
| `/mcp` | Streamable HTTP; one session = one server + one in-memory draft; idle sessions closed after 1 h |
| `GET /w/<id>` | `302` → `<site>#!c1.<packed>`; above `CODA_MCP_REDIRECT_MAX_CHARS` → `<site>#!https://<host>/w/<id>.json` (Coda prompts before fetching) |
| `GET /w/<id>.json` | stored `.coda.json`, `Access-Control-Allow-Origin: *` |

## Design

- **No Coda logic here.** All node knowledge comes from Coda's build (`<site>/mcp/v1/coda.js`,
  contract v1), downloaded at startup, cached with ETag, re-checked every `CODA_MCP_REFRESH_MINUTES`.
  A changed build (SHA-256 of its bytes) is imported under a new URL and used by new sessions only;
  old builds stay in memory until restart. Contract: [coda `docs/mcp.md`](https://github.com/navis-org/coda/blob/main/docs/mcp.md).
- **Offline.** Global `fetch` is replaced before Coda code runs; dataset nodes report unknown columns.
  `CODA_MCP_NETWORK=1` lifts this (not for public instances).
- **Short links.** id = first 22 chars of base64url SHA-256 over the draft; one file per link in
  `CODA_MCP_LINK_DIR`; retention by mtime, touched on open. Drafts are stored server-side; `full_link`
  stores nothing.

## Run

```bash
pnpm install && pnpm build
CODA_MCP_PUBLIC_URL=https://<host> node dist/cli.js --http --port 8787
```

Single instance (sessions are in memory). Behind nginx:

```nginx
limit_req_zone $binary_remote_addr zone=coda_mcp:10m rate=5r/s;

server {
    server_name <host>;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_buffering off;          # SSE
        proxy_read_timeout 1h;
        proxy_buffer_size 32k;        # > CODA_MCP_REDIRECT_MAX_CHARS, else 502 on long redirects
        limit_req zone=coda_mcp burst=40 nodelay;
    }
}
```

## Configuration

| Variable | Default | |
| -------- | ------- | - |
| `CODA_MCP_PUBLIC_URL` | — | external base URL (`https`); enables short links |
| `CODA_MCP_LINK_DIR` | `~/.local/share/coda-mcp/links` | short-link storage |
| `CODA_MCP_LINK_TTL_DAYS` | `0` | delete links unopened for N days; `0` keeps |
| `CODA_MCP_REDIRECT_MAX_CHARS` | `16000` | longest packed link served as a redirect |
| `CODA_MCP_ALLOWED_HOSTS` | public URL host | extra accepted `Host` headers (loopback always accepted) |
| `CODA_MCP_REFRESH_MINUTES` | `10` | build re-check interval; `0` disables |
| `CODA_ARTIFACT` | `https://coda.science/mcp/v1/coda.js` | Coda build: URL or path |
| `CODA_SITE_URL` | build's site | base URL of generated links |
| `CODA_MCP_CACHE` | `~/.cache/coda-mcp` | build cache |
| `CODA_MCP_NETWORK` | off | allow dataset requests |
| `NEUPRINT_APPLICATION_CREDENTIALS` | — | neuPrint token (network mode) |
| `CODA_CAVE_TOKENS` | — | JSON `{ "<cave server>": "<token>" }` (network mode) |

## Development

```bash
pnpm install
(cd ../coda && pnpm build:mcp)
pnpm typecheck && pnpm test   # build: $CODA_ARTIFACT, else ../coda/dist/mcp/v1/coda.js, else skipped
node dist/cli.js              # stdio, no short links
```

CI runs daily against the deployed build to catch contract drift.
