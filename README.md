# pproxy

Pool your [Puter](https://developer.puter.com/) accounts behind one local endpoint that speaks OpenAI and Anthropic. Sign in with as many Puter accounts as you like, pick how requests get spread across them, and point any client at `http://localhost:9032`.

```sh
npm i -g github:spacedouut/pproxy
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

## Model aliases

Clients often hardcode model names. Map them in the UI or with `pprox config modelMap '{"claude-*":"claude-sonnet-4-5","fast":"gpt-5.4-nano"}'`. `*` matches anything. Requests with no model use `defaultModel`.

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
