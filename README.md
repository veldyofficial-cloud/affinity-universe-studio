# AFFINITY UNIVERSE · Studio

Static front-end (`index.html`, `public/style.css`, `src/app.js`) plus a small Vercel backend
(`api/router.js` → `lib/*.js`) that replaces the ChatGPT-hosted server.

- **GitHub Pages** (`main` branch, `.github/workflows/pages.yml`): runs without a server.
  `index.html` loads `src/mock.js` (a localStorage stand-in for the API) only when the hostname ends with `github.io`.
- **Vercel**: the same front-end, with real API endpoints, storage in a private Vercel Blob store,
  admin login, and Monday sync. `src/mock.js` is not deployed.

## Deploy to Vercel

1. Import the GitHub repo in Vercel (framework preset: **Other**). `vercel.json` already sets the
   build (`node scripts/build-static.mjs`, which copies the static files into `dist/`), the output
   directory and the rewrites. You do not need to change any build settings.
2. **Storage → Create → Blob**, choose **Private** access, and connect it to the project.
   This injects `BLOB_READ_WRITE_TOKEN`. The store must be private because leads contain personal data.
3. Add the environment variables below (Production and Preview), then redeploy.
4. Open `https://<your-domain>/admin/login`, sign in, and check **연동 · 데이터 → Monday 연결 확인**.
5. Optional: import the old data (see below).
6. Optional but recommended: add a Vercel Firewall rate-limit rule for `/api/inquiries` and `/api/login`.
   The built-in limiter only works per function instance.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | yes | Password for `/admin/login`. Use a long random passphrase. |
| `SESSION_SECRET` | yes | HMAC key for the admin session cookie. At least 16 characters, for example `openssl rand -hex 32`. Changing it signs everyone out. |
| `BLOB_READ_WRITE_TOKEN` | yes (auto) | Injected when a Blob store is connected. |
| `MONDAY_API_TOKEN` | for Monday | Monday personal API token (admin → Developers → My access tokens) of an account that can write to both boards. |
| `MONDAY_DISTANCE_BOARD_ID` | for Monday | `[TEST] AF DISTANCE` board ID (the number in the board URL). |
| `MONDAY_REVENUE_BOARD_ID` | for Monday | `[TEST] 2026 REVENUE` board ID. |
| `MONDAY_DISTANCE_COLUMNS` | optional | JSON `{ "field": "columnId" }` for Distance **subitem** columns, for example `{"contact":"text_mk1","status":"status","trialDate":"date4"}` |
| `MONDAY_REVENUE_COLUMNS` | optional | Same for Revenue items, for example `{"cost":"numbers","revenueStatus":"status","commission20":"checkbox","paymentDate":"date"}` |
| `MONDAY_DISTANCE_GROUP_ID` / `MONDAY_REVENUE_GROUP_ID` | optional | Group for newly created items (defaults to the board's top group). |
| `MONDAY_API_VERSION` | optional | Pin a Monday API version header, for example `2025-10`. |

Mappable fields: `leadId identifier name contact phone kakaoId course source status message note date submittedAt
marketer referralCode referralChannel country region timezone guardianName availability device preferredSchedule
confirmedCurriculum studentName classSchedule instructor specialNotes studentDBId trialDate enrollmentDate renewalDate
paymentStatus paymentMethod payerName paymentEmail paymentDate amount paidAmount cost revenueStatus commission20`.
Values are formatted for the target column type (text, long text, numbers, status, dropdown, date, checkbox, email, phone, link).
`revenueStatus` is `CLEAR` (fully paid), `SPLIT` (partly paid) or `DUE` (nothing paid). `cost` is the amount actually paid.
Column IDs come from Monday: open a column's menu and choose **Column ID**. Developer mode must be on.

If any Monday variable is missing, **Monday 연결 확인** says which one, and sending to Monday returns a clear error. Nothing crashes.

## How Monday sync works

- **Distance**: one parent item per month (`YYYY-MM`, from the lead's Korea-time date), which is created if missing.
  Under it, one subitem per lead named `<이름> [AU:<lead id>]`.
- **Revenue**: one item per lead, but only when the status is `등록 완료`. Cancellations and refunds never delete or change existing revenue rows.
- The first send creates items. Later sends update the same item IDs.
- Before writing, the sync is marked `running`. If the connection drops while an item is being created, the lead goes to `review` and automatic retries stop,
  so no duplicates are created. Use **기존 아이템 ID 확인 · 연결** in the UI to enter the item IDs. An item is accepted only if its name contains `[AU:<lead id>]`.
  Leave the fields empty if nothing was created.

## Importing the old data

In the old Studio, go to **연동 · 데이터 → 전체 데이터 JSON 내려받기** and download `affinity-studio-backup.json`.
You must be an admin there. Then run this from a checkout of this repo (Node 20+):

```bash
ADMIN_PASSWORD='…' node scripts/import-backup.mjs affinity-studio-backup.json --url https://<your-domain>
# add --replace-config to overwrite the page / published page / reply rules if they already exist
```

How the import works:

- It calls the admin-only `POST /api/admin/import` and sends leads in batches.
- It is idempotent. Records whose ID already exists are skipped, never overwritten, so it is safe to re-run.
- What it imports:
  - page / published page / rules / posts / events. These are imported only if no config exists yet, or with `--replace-config`.
  - leads
  - marketers
  - links, with their old visit counts kept as `importedVisits`
  - link history
- The backup file from the old UI has no Monday sync state, lead change history or lead order.
  Leads that were already sent to Monday should be linked with **기존 아이템 ID 확인 · 연결** before they are sent again.
  Otherwise they create new items. The endpoint also accepts optional `syncs` (`[{lead_id, distance_id, revenue_id, state}]`) and `leadOrder` arrays if you have them.

The UI's own **이 브라우저의 기존 문의 가져오기** button (localStorage leads) also works against this backend.

## API

All responses are JSON. "admin" means a valid `au_admin` cookie is required (`403` otherwise).
State-changing admin calls must also come from the same origin.

| Method & path | Auth | Notes |
|---|---|---|
| `GET /api/public` | public | `{page: publishedPage, admin}` |
| `POST /api/login` / `POST /api/logout` | public | `{password, name?}`. Sets or clears an HttpOnly `SameSite=Lax` cookie, valid for 12 h. Limited to 10 tries per 15 min per IP. |
| `POST /api/visit` | public | `{code, referrer, landingUrl, timezone}`. Counted once per browser session per link. Stores the attribution cookie. Admin previews are not counted. |
| `GET /api/residence-options` | public | countries / regions / time zones |
| `POST /api/inquiries` | public (admin for `manual`/`imported`) | Validated server-side. Adds a Vercel geo snapshot (`x-vercel-ip-*`) and link/marketer attribution. Idempotent by `id`. Limited to 5 per 10 min per IP. |
| `GET /api/media/:id` | public | Streams the file from private Blob, with Range support. |
| `GET, PUT /api/admin/state` | admin | `PUT {config, revision}`. Returns `409` if `revision` is stale. |
| `PATCH /api/admin/leads` | admin | `{id, opsRevision, status?, note?, operations?, archived?, deleted?}`. Returns `409` if `opsRevision` is stale. Writes a history entry. |
| `POST /api/admin/lead-history` | admin | `{id}` → `{history:[{at, actor, after_json}]}` |
| `POST /api/admin/lead-order` | admin | `{ids, revision}`. Returns `409` if stale. |
| `GET, POST, PATCH /api/admin/links` | admin | Links have a `revision`, and history is written on every change. |
| `POST, PATCH /api/admin/marketers` | admin | A marketer who still has active links cannot be retired. |
| `POST /api/admin/media` | admin | Raw body, `Content-Type` + `X-File-Name`. JPG/PNG/WebP/GIF up to 10 MB, MP4/WebM up to 25 MB. |
| `POST /api/admin/media/upload`, `/complete` | admin | Client upload for files over 4 MB (Vercel's request limit is 4.5 MB). Used by the UI automatically. |
| `POST /api/admin/monday/check`, `/sync`, `/reconcile` | admin | See above. |
| `POST /api/admin/import` | admin | Backup import, described above. |

### Storage layout (private Blob)

To avoid lost updates, each record is its own blob, and every update is a conditional write (`ifMatch` ETag):

```
config/state.json         {config:{page,published,rules,…}, revision}
config/lead-order.json    {ids, revision}
leads/<id>.json           one per lead (opsRevision)
syncs/<leadId>.json       Monday sync state per lead
links/<id>.json, marketers/<id>.json
history/leads/<id>/…json, history/links/<id>/…json   one blob per history entry
visits/<code|_direct>/<sessionId>.json                one blob per session visit (counted with list)
media/<id>/<file>, media-meta/<id>.json
```

`GET /api/admin/state` reads every lead. This is fine for hundreds or a few thousand leads.
At larger volumes, move to a database (for example Neon Postgres from the Vercel Marketplace).

## Local development and tests

```bash
npm install
npm test                                   # endpoint harness: file-system store + fake Monday API
ADMIN_PASSWORD=dev-pass SESSION_SECRET=dev-secret-0123456789 npm run dev   # http://localhost:3000 (store in .local-data/)
python test/e2e.py http://localhost:3000 dev-pass                          # Playwright browser test
```

`scripts/dev-server.mjs` mimics `vercel dev`. It builds `dist/`, applies the `vercel.json` rewrites and runs the same handlers
with `lib/store-fs.js`, which implements the same interface as the Blob adapter in `lib/store.js`.
`DEV_GEO="KR,11,Seoul,Asia/Seoul"` fakes the Vercel geo headers.
