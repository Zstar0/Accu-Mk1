# Integration keys in Settings - design

Date: 2026-10-10. Status: approved in conversation, awaiting written-spec review.

## 1. Intent

Let an admin set, replace, test and clear the third-party API keys Mk1 uses (Close, Plain, Anthropic) from a Settings page, instead of someone appending them to the prod `backend/.env` over ssh.

- **Who:** Mk1 admins (the Handler today).
- **Success:**
  - An admin pastes a new key into Settings, Mk1 tests it against the provider, and the key is live for the next request without a deploy or restart.
  - Nobody, admins included, can read a stored key back.
  - Every change is on record with who made it and when.

### Rulings (Handler, 2026-10-10)

- Build it as its own admin-only "Integrations" pane. Do not reuse the existing `settings` table, which any logged-in user can read in plain text (`GET /settings`, `main.py:1984`).
- Encrypt with a **dedicated** key from the server env, not one derived from `JWT_SECRET`. `JWT_SECRET` is shared with the Integration Service and COA Builder, so rotating it would make every stored value unreadable at once.
- Write-only: the page shows that a key is set, its last four characters, and who set it when. Never the value.
- The env file stays the fallback: a key saved in Settings overrides the env value; with nothing saved, the env value is used.
- Scope: third-party API keys only (`CLOSE_API_KEY`, `PLAIN_API_KEY`, `ANTHROPIC_API_KEY`). Infrastructure secrets stay in the env file: `JWT_SECRET`, the database password, the internal service token and the WooCommerce keys, because they are shared between services or needed to boot.

### Out of scope

Rotating the encryption key itself (re-enter the values after a rotation); non-admin access; keys for the Integration Service, COA Builder or WordPress; moving any infrastructure secret out of the env file; a secrets manager (Vault, Doppler, DO secrets).

## 2. Findings that shape the design

- The three clients already rebuild themselves when their key changes: `crm_close/client.py:69`, `customer_review/llm.py:82` and `support_plain/client.py:79` read the env var on every `get_client()` call and swap the pooled client when the value differs. Swapping `os.environ.get(NAME)` for a resolver call makes a new key live on the next request, with no restart.
- `cryptography` is already installed (via `python-jose[cryptography]`), and `main.py:16799` already uses Fernet for SENAITE passwords, keyed from `JWT_SECRET`. This design uses the same library with its own key.
- The settings navigation (`src/components/preferences/panes.tsx`) has no role filter. Panes enforce admin on the server; the new pane also hides its nav item from non-admins.
- Prod runs a single uvicorn worker, so an in-process cache invalidated on write is coherent.

## 3. Architecture

```
Settings > Integrations (admin)
   -> GET    /admin/integrations                 status rows, never values
   -> PUT    /admin/integrations/{name}          {value}: test with the provider, then encrypt + store
   -> POST   /admin/integrations/{name}/test     test the key currently in effect
   -> DELETE /admin/integrations/{name}          drop the stored value (env fallback takes over)

crm_close / support_plain / customer_review get_client()
   -> integration_keys.get(NAME)    stored value (decrypted, cached) else env else None
```

New package `backend/integration_keys/`:

| File | Responsibility |
|---|---|
| `registry.py` | The allowlist: name, label, and the test call per provider. |
| `store.py` | Encrypt, decrypt, read, write, clear; the in-process cache; the audit rows. |
| `routes.py` | The four admin endpoints. |

### 3.1 The allowlist

| Name | Label | Test call (read-only, free) |
|---|---|---|
| `CLOSE_API_KEY` | Close CRM | `GET https://api.close.com/api/v1/me/` |
| `PLAIN_API_KEY` | Plain support | GraphQL `query { myWorkspace { id } }` |
| `ANTHROPIC_API_KEY` | Anthropic (AI review) | `GET https://api.anthropic.com/v1/models?limit=1` |

Any other name returns 404 from every endpoint. Each test has a 10 s timeout and no retry. A test passes on HTTP 2xx (and, for Plain, no GraphQL `errors`); 401 or 403 is "key rejected"; anything else is "provider unavailable".

### 3.2 Storage

`integration_keys` table:

| Column | Type |
|---|---|
| name | text PK (an allowlisted name) |
| ciphertext | text (Fernet token) |
| last4 | text (last 4 characters of the key) |
| updated_by | int (Mk1 user id) |
| updated_at | timestamptz |

`integration_key_events` table (audit):

| Column | Type |
|---|---|
| id | int PK |
| at | timestamptz |
| name | text |
| action | text (`set`, `cleared`, `tested`) |
| user_id | int |
| outcome | text (`ok`, `rejected`, `unavailable`, `undecryptable`) |

- Fernet key: env `INTEGRATION_KEYS_SECRET` (a urlsafe base64 32-byte key, `Fernet.generate_key()`). Without it, the feature is off: GET still lists rows with `configured: false`, writes return 503 `keys_not_configured`, and the resolver uses env values only.
- Neither table, nor any log line, ever holds a plaintext key. Request bodies are never logged.

### 3.3 Resolver `integration_keys.get(name) -> str | None`

1. A stored row that decrypts: use it.
2. A stored row that fails to decrypt (the encryption key changed): log `integration_keys.undecryptable name=...` once per process, use the env value, and report `undecryptable` in the status row so the admin re-enters it.
3. No stored row: the env value (stripped), or None.

The decrypted values are cached in-process for 60 s. Every write or clear drops the cache, so a new key is live on the next request.

### 3.4 Saving a key

`PUT /admin/integrations/{name}` with `{value}`:

1. Trim; reject empty or longer than 512 characters (422).
2. Run the provider test with the candidate value.
   - Rejected: 422 `key_rejected`, nothing stored.
   - Provider unavailable: 502 `provider_unavailable`, nothing stored.
3. Encrypt, upsert the row, write a `set` event, drop the cache.
4. Return the status row.

A key that the provider rejects is never stored, so a typo cannot take an integration down.

## 4. API

All require `require_admin`. Values are never in any response.

| Method and path | Body | Success |
|---|---|---|
| `GET /admin/integrations` | | `{configured: bool, keys: [{name, label, source: "settings"|"env"|"none", last4: str|null, updated_by_name: str|null, updated_at: str|null, undecryptable: bool}]}` |
| `PUT /admin/integrations/{name}` | `{value: str}` | the status row |
| `POST /admin/integrations/{name}/test` | | `{ok: bool, outcome: "ok"|"rejected"|"unavailable"|"not_set"}` |
| `DELETE /admin/integrations/{name}` | | the status row (now `env` or `none`) |

`last4` for an env-sourced key is computed from the env value at request time (the env value is never returned).

## 5. UI

A new Settings pane **Integrations** (`src/components/preferences/panes/IntegrationsPane.tsx`). Its nav item shows only for admins.

- One row per provider: label; a source badge ("Saved in Settings", "From server env", "Not set"); "ends in a3f9"; "Updated by Forrest, Oct 10"; and buttons **Replace**, **Test**, and **Use server env** (shown only when the source is Settings).
- **Replace** opens an inline password-type field with **Save and test**. While saving it shows "Testing with Close..."; on success the row updates and the field clears; on failure the field keeps its value and shows "Close rejected this key" or "Close is not answering; nothing was saved".
- **Test** shows "Working" or the failure reason inline.
- When `configured` is false, the pane says "Key storage is not set up on this server (INTEGRATION_KEYS_SECRET is missing). Keys still come from the server env." and the Replace buttons are disabled.
- An `undecryptable` row says "The saved key can't be read (the encryption key changed). Using the server env value. Replace it to fix."
- The field has `autocomplete="off"` and is cleared on unmount; nothing is written to `localStorage`.

## 6. Security

- **Threat: a stored key leaks from the database or a backup.** Mitigation: only Fernet ciphertext is stored; the decryption key is only in the server env, never in the database or the repo.
- **Threat: a non-admin reads or changes keys.** Mitigation: every endpoint is `require_admin`; the existing world-readable `settings` table is not used.
- **Threat: a stolen admin login.** It can replace a key (for example with one the attacker controls) but can never read the current key. The `set` event records who did it; the Handler sees the change in the pane.
- **Threat: a bad key takes an integration down.** Mitigation: a key is only stored after the provider accepts it; **Use server env** reverts instantly.
- **Threat: keys in logs.** Mitigation: no request body or key value is logged; tests log only name and outcome.
- Fails closed: without `INTEGRATION_KEYS_SECRET`, nothing can be stored.

## 7. Rollout

1. On the prod droplet, generate the Fernet key inside the backend container and append it to `backend/.env` as `INTEGRATION_KEYS_SECRET`, with a dated backup, without printing it. Also save a copy in the Accumark vault for disaster recovery (Handler).
2. Deploy. The backend creates both tables. Prod injects `backend/.env` through compose `env_file`, so the deploy's container recreate is what loads the new variable: a plain restart would not.
3. Smoke: the pane lists three rows from `env`; **Test** each (all ok); save the current Close key through the pane (source changes to Settings); **Use server env** reverts it.
4. Support actions rollout (PR #300) then needs no ssh: the Handler pastes the new Plain read-write key into this pane.

## 8. Errors

| Condition | HTTP | Code |
|---|---|---|
| Not an admin | 403 | (FastAPI default) |
| Name not on the allowlist | 404 | `unknown_key` |
| Empty or oversized value | 422 | `invalid_input` |
| Provider rejected the key | 422 | `key_rejected` |
| Provider did not answer | 502 | `provider_unavailable` |
| `INTEGRATION_KEYS_SECRET` missing (writes) | 503 | `keys_not_configured` |

## 9. Testing

Backend (SQLite plus an httpx MockTransport for the providers):
- Encrypt and decrypt round trip; ciphertext differs from the value; no column holds the plaintext.
- Resolver order: settings, then env, then None; an undecryptable row falls back to env and reports it.
- Cache: a save or clear is visible on the next `get()`.
- PUT: accepted, rejected (nothing stored), unavailable (nothing stored), oversized.
- DELETE reverts to env.
- Every endpoint: non-admin 403; unknown name 404; missing secret gives 503 on writes and `configured: false` on GET.
- No response body anywhere contains the key value.
- Each client factory (`crm_close`, `support_plain`, `customer_review`) picks up a saved key without a restart.

Frontend (vitest):
- Nav item hidden for non-admins.
- Save success clears the field; failure keeps it and shows the reason.
- The not-configured and undecryptable states render their messages.
