# pproxy

Pool your [Puter](https://developer.puter.com/) accounts behind one local endpoint that speaks OpenAI and Anthropic. Sign in with as many Puter accounts as you like, pick how requests get spread across them, and point any client at `http://localhost:9032`.

```sh
npm i -g pproxy
pprox serve --bg
pprox accounts add        # opens Puter sign-in in your browser
```

Then use it like any other API:

```sh
curl localhost:9032/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"gpt-5.4-nano","messages":[{"role":"user","content":"hi"}]}'
```

```sh
export ANTHROPIC_BASE_URL=http://localhost:9032    # Claude Code, Anthropic SDKs
export OPENAI_BASE_URL=http://localhost:9032/v1    # OpenAI SDKs, Codex, etc.
```

The web UI lives at the same address (`pprox open`). It shows each account's monthly credit, lets you add/disable/remove accounts, pick a routing strategy, and set model aliases.

## Endpoints

| API | Path |
| --- | --- |
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| OpenAI Responses | `POST /v1/responses` |
| Anthropic Messages | `POST /v1/messages` (also `/messages`) |
| Anthropic token count (estimate) | `POST /v1/messages/count_tokens` |
| Models | `GET /v1/models` |

The `/v1` prefix is optional on all of them. Streaming and non-streaming both work.

What gets translated: system/developer prompts, multi-turn history, images (data URLs and http URLs), function tools and tool results, tool choice, parallel tool calls, stop sequences, JSON schema output, reasoning effort, Anthropic extended thinking (signatures survive the round trip, so multi-turn thinking with tools works), cache_control, and web search tools. `previous_response_id` works for the Responses API while the server is running (kept in memory, last 500 responses).

What doesn't: audio input, file/document uploads other than plain text, and retrieving stored responses by id. Unsupported content is replaced with a short placeholder so the model knows something was left out.

Send `x-pproxy-account: <username or id>` to pin one request to a specific account. Every response carries `x-pproxy-account` saying which account served it.

## Routing

| Strategy | What it does |
| --- | --- |
| `round-robin` | Rotate through accounts in turn (default) |
| `most-remaining` | Send to whichever account has the most monthly credit left |
| `least-busy` | Send to the account with the fewest requests in flight |
| `priority` | Use accounts in list order; the next one only gets traffic when earlier ones fail |
| `random` | Random pick, weighted by each account's weight |

With failover on (the default), a request that hits an auth error, rate limit, or empty balance on one account is retried on the next one, as long as nothing has been streamed back yet. Accounts that run dry are skipped until their usage refreshes (every 5 minutes, or `pprox accounts refresh`).

## CLI

```
pprox serve [--port 9032] [--host 127.0.0.1] [--bg]
pprox stop | status | open | logs [-f]
pprox accounts [list]
pprox accounts add [--headless] [--token TOKEN]
pprox accounts rm|enable|disable <id|username>
pprox accounts refresh
pprox strategy [name]
pprox config [key] [value]
pprox models [filter]
```

`--headless` prints the sign-in link instead of opening a browser. If the machine you sign in on can't reach the server, copy the `token=` value from the page Puter redirects to and pass it to `--token`.

## Management API

A small HTTP API for scripting the pool. It is off until you set a master key:

```sh
pprox manage key            # prints the key, creating one if needed (--rotate for a new one)
# or: PPROXY_MASTER_KEY=... pprox serve
```

Send the key as `Authorization: Bearer <key>` or `x-master-key: <key>`. The client API key is not accepted here.

| Action | Body |
| --- | --- |
| `POST /manage/v1/add-account` | `{"token": "..."}`, or `{}` to get a Puter sign-in `url` back |
| `POST /manage/v1/remove-account` | `{"account": "<id or username>"}` |
| `POST /manage/v1/change-weight` | `{"account": "...", "weight": 3}` |
| `POST /manage/v1/enable-account` / `disable-account` | `{"account": "..."}` |
| `POST /manage/v1/set-strategy` | `{"strategy": "most-remaining"}` |
| `POST /manage/v1/refresh-usage` | `{"account": "..."}` or `{}` for all |

Every action returns a request record and an `X-Request-Id` header:

```json
{"request_id": "req_...", "action": "change-weight", "status": "succeeded", "result": {...}, "error": null}
```

`status` is `pending`, `succeeded` or `failed`; on failure `error` has `message` and `status`, and the HTTP status matches. Add `"async": true` (or `?async=1`) to get a `202` right away and poll instead. `add-account` without a token stays `pending` until someone finishes signing in through the returned `url`.

Reads: `GET /manage/v1/request?id=req_...` (or `/manage/v1/request/req_...`), `GET /manage/v1/requests?limit=50`, `GET /manage/v1/accounts`. The last 1000 requests are kept in memory.

## Discord bot

`discord/` has a small bot that adds accounts through the management API, so people can add their Puter accounts from Discord without touching the server. It isn't part of the npm package; run it from a checkout:

```sh
cd discord && npm install
DISCORD_TOKEN=... PPROXY_MASTER_KEY=... npm start
```

Commands (replies are only visible to whoever ran them):

- `/add` sends a Puter sign-in button and updates the message once the account is added.
- `/add token:<token>` adds an account straight from a Puter token.
- `/usage` shows a bar image of credit used and left across all accounts.
- `/accounts` lists accounts and their remaining credit.

All commands need Manage Server by default (change that under Server Settings > Integrations). Other settings:

| Env | Default | |
| --- | --- | --- |
| `PPROXY_URL` | `http://127.0.0.1:9032` | Where the bot reaches pproxy |
| `PPROXY_PUBLIC_URL` | same as `PPROXY_URL` | Where Puter sends the browser back after sign-in. Set this if the people signing in can't reach `PPROXY_URL`. pproxy rejects non-local `Host` headers while bound to `127.0.0.1`, so behind a reverse proxy either have it send `Host: localhost` or bind pproxy to another interface with an API key |
| `DISCORD_ALLOWED_USERS` | anyone with the permission | Comma-separated Discord user ids |
| `DISCORD_GUILD_ID` | global | Register commands in one server (shows up instantly; global can take a while) |

If the sign-in redirect can't reach pproxy, the page won't load, but the `token=` value is still in its address bar; paste it into `/add token:`.

## Model aliases

Clients often hardcode model names. Map them in the UI or with `pprox config modelMap '{"claude-*":"claude-sonnet-4-6","fast":"gpt-5.4-nano"}'`. `*` matches anything. Requests with no model use `defaultModel`.

## Config and security

Everything lives in `~/.pproxy` (override with `PPROXY_HOME`): `settings.json`, `accounts.json` (Puter tokens, file mode 600), the pid file and the background log.

The server binds to `127.0.0.1` by default and rejects requests whose `Host` isn't local or whose `Origin` doesn't match, so random web pages can't use your credits. If you bind it to another interface, set an API key (`pprox config apiKey <key>` or in the UI); clients then send it as `Authorization: Bearer <key>` or `x-api-key`.

## Development

```sh
npm install
npm test
node bin/pprox.js serve
```

Requires Node 20+.
