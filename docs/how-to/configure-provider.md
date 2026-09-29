# Connect an OpenAI-compatible gateway

**Goal:** point the workbench at a real LLM instead of the offline mock.

**Before you start:** you have run the zero-credential mode from the
[quickstart](../tutorials/quickstart.md), and you have a gateway URL + API key.

## 1. Put the credentials in `./.env`

The workbench speaks to **OpenAI-Responses-compatible gateways** (the public
OpenAI API, or any self-hosted or vendor gateway speaking the Responses wire
shape). Copy `.env.example` to `.env` and fill in two keys:

```dotenv
LLM_PROVIDER=auto
LLM_BASE_URL=https://your-gateway.example.com/v1
LLM_API_KEY=sk-…
```

- `LLM_BASE_URL` is the **gateway root** — the provider appends `/responses`
  itself. A URL that already ends in `/responses` is the most common mistake.
- `LLM_PROVIDER=auto` (the default) uses the gateway when both values are set
  and falls back to the offline mock otherwise, so an empty `.env` never breaks
  boot. Setting `openai` explicitly *without* credentials fails at boot on
  purpose: that is a typo, not a fallback.
- Environment variables win over the file, and the file is read from the
  **process working directory**.

## 2. Put your models in `models.json`

The menu the model picker shows comes from `./models.json`, not from the
gateway:

```json
{
  "models": [
    {
      "id": "your-model-id",
      "label": "Your model",
      "default": true,
      "efforts": ["low", "medium", "high"],
      "default_effort": "medium",
      "context_window": 200000,
      "max_output_tokens": 32000
    }
  ]
}
```

- Exactly one entry carries `default: true`.
- `efforts` / `default_effort` drive the reasoning-effort picker. A model with
  no reasoning levels lists none.
- **Give a custom model `context_window` and `max_output_tokens`.** They
  register the model's spec, driving context compaction and the output-token
  ceiling. Omit them and the model is still registered — with a conservative
  default and a startup **warning** — so compaction stays on; but the default is
  a guess, so declare the real values to make it accurate (and silence the
  warning). A vision-capable model also needs `"supports_vision": true`, or
  image inputs to it are rejected.
- A missing or unparseable file degrades to a single fallback model with a
  warning; the backend never crashes over model config.

## 3. Restart and check

```bash
curl -s http://127.0.0.1:8000/api/v1/health
# {"status":"ok","version":"…","provider":"openai","sandbox_available":false,"data_dir":"…"}
```

`"provider": "mock"` means the credentials did not take.

## A second gateway

Models can route to a second Responses-compatible gateway: set
`SECONDARY_LLM_BASE_URL` + `SECONDARY_LLM_API_KEY` and tag the routed entries
with `"gateway": "secondary"` in `models.json`. The secondary only stacks on top
of an active primary — it never stands alone. Both keys must be set to count as
configured.

## Session titles

Titles are generated asynchronously by a separate, cheap call that sends
reasoning effort `"none"`, so `TITLE_MODEL` **must be a non-reasoning model**
(empty = the default chat model). Under the mock provider no title is generated
at all; the session is labelled with the first line of your message instead, and
a real gateway replaces it later.

## Troubleshooting

- **`/health` says `"provider": "mock"`** — `LLM_BASE_URL` or `LLM_API_KEY` is
  empty (auto fell back), or the `.env` you edited is not in the directory you
  started the process from.
- **401 / authentication error** — check the key. Both gateways authenticate
  with `Authorization: Bearer`.
- **The model is missing from the picker** — the menu is `models.json`, not the
  gateway. Add the entry.
- **A long conversation grows without compaction** — a model registered with a
  too-small or defaulted `context_window`. Declare the real `context_window` /
  `max_output_tokens` in `models.json` (a startup warning flags any model still
  on the default).
- **422 `invalid_model` / `model_not_allowed`** — the request named a model or
  an effort outside the catalogue. This is refused synchronously and never
  reaches the provider.

## See also

- [Configuration reference](../reference/configuration.md) — every key
- [Use the workbench](use-the-workbench.md) — the UI walkthrough
