# SENAITE Secondary AR — Verified REST Contract

**Status:** Verified against running SENAITE 2.7.0 (`http://localhost:8080/senaite/`) on 2026-04-27.
**Source of truth:** `senaite.jsonapi` v1 routes (`senaite.jsonapi.v1.routes.content`) +
`bika.lims.utils.analysisrequest.create_analysisrequest`.

This document captures the exact public REST API used to create an
`AnalysisRequestSecondary` (sub-sample), upload an image attachment to it, and
fetch all secondaries of a parent for drift reconciliation. It is the ground
truth for the Sub-Samples feature in Accu-Mk1.

---

## 1. Create a Secondary AR

### Endpoint

```
POST http://<senaite-host>/senaite/@@API/senaite/v1/create
```

### Headers

```
Content-Type: application/json
Authorization: Basic <base64(user:password)>
```

The endpoint also accepts cookie-based session auth, but the integration uses
HTTP Basic via the `senaite_auth` httpx client.

### Required body fields

| Field                    | Required | Notes                                                                                              |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------- |
| `portal_type`            | yes      | Must be `"AnalysisRequest"`. Triggers the AR-specific code path in `senaite.jsonapi.api.create_object`. |
| `parent_uid`             | yes      | UID of the **Client** folder that owns the AR. Same client as the primary. |
| `PrimaryAnalysisRequest` | yes\*    | UID of the parent AR. **\*If present and resolvable**, SENAITE applies the `IAnalysisRequestSecondary` marker interface and renames the new AR to `<parent_id>-S<NN>`. **If the UID is wrong/unknown, SENAITE silently creates a normal AR** (no error). The caller MUST verify the response `id` matches the `-SNN` pattern. |
| `SampleType`             | yes      | UID of the Sample Type. Required even though it is conceptually inheritable from the primary. |
| `Contact`                | no       | Optional. If omitted the secondary is created with a null contact (no error). |

### Working request

```bash
curl -u admin:<password> -X POST \
  http://localhost:8080/senaite/@@API/senaite/v1/create \
  -H "Content-Type: application/json" \
  -d '{
    "portal_type": "AnalysisRequest",
    "parent_uid": "<CLIENT_UID>",
    "PrimaryAnalysisRequest": "<PARENT_AR_UID>",
    "Contact": "<CONTACT_UID>",
    "SampleType": "<SAMPLE_TYPE_UID>"
  }'
```

`Client` does NOT need to be passed — `create_analysisrequest` overwrites it
to the container (`parent_uid`) regardless of what the caller sends.

### Sample real 200 response (truncated)

```json
{
  "count": 1,
  "items": [
    {
      "id": "P-0129-S01",
      "title": "P-0129-S01",
      "uid": "a8a8c46f01d04ed1b9f29f072509afc6",
      "portal_type": "AnalysisRequest",
      "review_state": "sample_received",
      "path": "/senaite/clients/client-8/P-0129-S01",
      "parent_path": "/senaite/clients/client-8",
      "parent_uid": "c5e203e5ed034bf2ba5effa8a858f925",
      "DateSampled": "2026-04-01T00:00:00-07:00",
      "DateReceived": "2026-04-22T19:57:46-07:00",
      "ReceivedBy": "admin",
      "PrimaryAnalysisRequest": {
        "uid": "d7fb7d691c024652b697b8260d44ecd3",
        "url": "http://localhost:8080/senaite/clients/client-8/P-0129",
        "api_url": "http://localhost:8080/senaite/@@API/senaite/v1/analysisrequest/d7fb7d691c024652b697b8260d44ecd3"
      },
      "Client": {
        "uid": "c5e203e5ed034bf2ba5effa8a858f925",
        "url": "http://localhost:8080/senaite/clients/client-8"
      },
      "Contact": {
        "uid": "17c5d2446671485282bfcdbd36f2cdbd"
      },
      "SampleType": {
        "uid": "15c7f60939cc4d9089bc2fe238e57f06"
      },
      "Analyses": [],
      "api_url": "http://localhost:8080/senaite/@@API/senaite/v1/analysisrequest/a8a8c46f01d04ed1b9f29f072509afc6"
    }
  ],
  "url": "http://localhost:8080/senaite/@@API/senaite/v1/create",
  "_runtime": 0.079
}
```

### Success criterion

The `items[0].id` MUST match the regex `^<parent_id>-S\d{2}$` (e.g.
`P-0129-S01`, `P-0129-S02`). If it does not, the secondary marker was NOT
applied and the call must be treated as a failure (the orphan AR should be
deleted or reconciled).

### Error cases observed

| Trigger                                           | HTTP | `message`                                                                  | Cause                                                                                              |
| ------------------------------------------------- | ---- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Missing `portal_type`                             | 400  | `Please provide a container path/uid and portal_type`                      | `senaite.jsonapi.api.create_items` early-out check.                                                |
| Missing `parent_uid` AND `parent_path`            | 400  | `Please provide a container path/uid and portal_type`                      | Same code path — needs a target container.                                                         |
| `parent_uid` not found                            | 404  | `No target container found`                                                | `find_target_container` returned nothing.                                                          |
| Missing `SampleType`                              | 400  | `No Objects could be created`                                              | `create_analysisrequest` raises during AR construction; transaction rolled back. Detail in Zope log. |
| Bad/unknown `PrimaryAnalysisRequest` UID          | 200  | (success — but `id` is `P-0135`, not `-SNN`)                               | **Silent fallthrough.** SENAITE creates a normal AR. The caller MUST validate the response id.    |
| Wrong field name (`Primary`, `primary_uid`, etc.) | 200  | (success — but `id` is normal AR id)                                       | Same silent fallthrough — the unknown field is dropped, the AR is created without the secondary marker. |

**Field-name lock-in:** the field is `PrimaryAnalysisRequest` (PascalCase,
exact spelling). Verified by reading
`bika.lims.utils.analysisrequest.create_analysisrequest`:

```python
primary = ar.getPrimaryAnalysisRequest()
if primary:
    alsoProvides(ar, IAnalysisRequestSecondary)
    ar.setDateSampled(primary.getDateSampled())
    ar.setSamplingDate(primary.getSamplingDate())
    # ... auto-receives the secondary if primary was received
```

### Auto-applied state on a successful secondary

These are set by the secondary code path in
`bika.lims.utils.analysisrequest.create_analysisrequest`:

- `IAnalysisRequestSecondary` marker interface (drives the `-SNN` rename in
  `senaite.core.idserver`).
- `DateSampled` and `SamplingDate` copied from the primary.
- If the primary has a `DateReceived`, the secondary is force-transitioned to
  `sample_received` and inherits the same `DateReceived`.

The caller does NOT need to pass these.

---

## 2. Upload an Image Attachment

The JSON API does NOT have a clean attachment-upload route for ARs. The
existing `backend/main.py:10912-10950` flow uses the standard SENAITE web form
endpoint, which works identically against a secondary's path.

### Endpoint

```
POST http://<senaite-host>/senaite/clients/<client-id>/<sample-id>/@@attachments_view/add
```

For a secondary, `<sample-id>` is the `-SNN` id (e.g. `P-0129-S01`).
Equivalently, the `path` field returned in the create response can be used
directly: `<senaite-host><path>/@@attachments_view/add`.

### Required preflight: CSRF authenticator

GET the AR detail page first and scrape the `_authenticator` token:

```bash
curl -u admin:<password> http://localhost:8080/senaite/clients/client-8/P-0129-S01 \
  | grep -oP '_authenticator" value="\K[^"]+'
```

### Form (multipart/form-data) body

| Field                              | Value                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `submitted`                        | `1`                                                                                  |
| `_authenticator`                   | the token from the preflight GET                                                     |
| `AttachmentType`                   | UID of the "Sample Image" attachment type (scrape from the same page HTML)           |
| `Analysis`                         | empty string — empty means "Attach to Sample"                                        |
| `AttachmentKeys`                   | empty string                                                                         |
| `RenderInReport:boolean`           | `True`                                                                               |
| `RenderInReport:boolean:default`   | `False`                                                                              |
| `addARAttachment`                  | `Add Attachment` (button name; required for the form handler)                        |
| `AttachmentFile_file` (file part)  | `(filename, image_bytes, image/png)`                                                 |

### Expected response

`200`, `301`, or `302` indicates the attachment was accepted. Anything else
should be treated as a failure (existing flow does this).

### Quirk

This is an HTML form endpoint, not a JSON API. The same code path used for
the primary's image works for a secondary because the `@@attachments_view`
view is registered on `IAnalysisRequest`, which both the primary and the
secondary provide.

---

## 3. Fetch Secondaries of a Parent

This is needed for drift reconciliation in Sub-Samples Task 6.

### Sharp edge

The `senaite.jsonapi` v1 routes use the default `portal_catalog` for AR
queries. `portal_catalog` does NOT have the `getRawParentAnalysisRequest`
or `getPrimaryAnalysisRequestUID` indexes. As a result, **filtering AR list
queries by parent UID does not work** — the unknown index is silently dropped
and the endpoint returns all ARs.

Probes that did NOT filter:

- `?PrimaryAnalysisRequest=<uid>` — returns all 74 ARs.
- `?getRawParentAnalysisRequest=<uid>` — returns all 74 ARs.
- `?catalog=senaite_catalog_sample&getRawParentAnalysisRequest=<uid>` — same.

### Working strategies

#### A. SearchableText scan (recommended for reconciliation)

```bash
GET http://<senaite-host>/senaite/@@API/senaite/v1/search?portal_type=AnalysisRequest&q=<PARENT_ID>
```

Returns the parent + all of its secondaries (matched by SearchableText on the
parent id, which is a substring of `<parent_id>-S01`, etc.). Filter the
response client-side for ids matching `^<parent_id>-S\d{2}$`.

Verified for `q=P-0129`:

```json
{
  "count": 2,
  "items": [
    { "id": "P-0129",     "uid": "d7fb7d691c024652b697b8260d44ecd3" },
    { "id": "P-0129-S01", "uid": "a8a8c46f01d04ed1b9f29f072509afc6" }
  ]
}
```

#### B. Exact-id GET (when you already know the secondary id)

```bash
GET http://<senaite-host>/senaite/@@API/senaite/v1/AnalysisRequest?id=<PARENT_ID>-S<NN>
```

Returns count=1 if the secondary exists. Useful for idempotent re-creation
checks.

#### C. Verbose response on the new secondary

When you have the secondary's UID (e.g. from your own Postgres mirror), a
direct GET returns the full record including the resolved
`PrimaryAnalysisRequest` reference:

```bash
GET http://<senaite-host>/senaite/@@API/senaite/v1/AnalysisRequest/<SECONDARY_UID>?complete=true
```

The list endpoint (`?id=<id>` form) returns a minimal projection; complete
fields require the UID-path form OR `?complete=true`.

---

## 4. End-to-End Quirks Summary

1. **`PrimaryAnalysisRequest` is silent on bad UIDs.** A wrong UID does not
   produce a 4xx — it produces a normal AR. Validate `id` against
   `^<parent_id>-S\d{2}$` after every create.
2. **`Contact` is optional**, `SampleType` is mandatory. The schema field
   name is `SampleType` (PascalCase).
3. **`Client` is overwritten by the container.** Don't bother sending it.
4. **Date fields are inherited from the primary** (`DateSampled`,
   `SamplingDate`, and — if applicable — `DateReceived` plus auto-receive
   transition). Don't pass them; you'll be overridden.
5. **The list endpoint cannot filter by parent UID** because the parent index
   is on `senaite_catalog_sample`, not `portal_catalog`. Use SearchableText
   `q=<parent_id>` and filter ids client-side, or scan by exact id.
6. **Image upload uses the HTML form endpoint, not the JSON API.** It works
   for secondaries because the secondary AR provides the same
   `IAnalysisRequest` interface.
7. **Sequence numbers are managed by SENAITE.** First secondary on a parent
   gets `-S01`, next gets `-S02`, etc. Don't try to assign IDs from
   Accu-Mk1 — let SENAITE rename.

---

## 5. Reference Source Files (in the SENAITE container)

- `/home/senaite/senaitelims/src/senaite.jsonapi/src/senaite/jsonapi/v1/routes/content.py` — REST routes.
- `/home/senaite/senaitelims/src/senaite.jsonapi/src/senaite/jsonapi/api.py` — `create_items`, `create_object`, `find_target_container`.
- `/home/senaite/senaitelims/src/senaite.core/src/bika/lims/utils/analysisrequest.py:58` — `create_analysisrequest`, where `IAnalysisRequestSecondary` is applied.
- `/home/senaite/senaitelims/src/senaite.core/src/senaite/core/idserver.py` — the `-SNN` ID format applied via the `IAnalysisRequestSecondary` marker.
- `/home/senaite/senaitelims/src/senaite.core/src/senaite/core/catalog/sample_catalog.py:90` — confirms `getRawParentAnalysisRequest` lives on the sample catalog only.
