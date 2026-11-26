# QA Dashboard

**SIMULASI AGENT — bukan integrasi QA OpenBot; penyimpanan Supabase**

> Catatan status UI: Banner `SIMULATION_LABEL` tetap dipertahankan di aplikasi sampai pengujian end-to-end penuh ke webhook routine OpenBot Jess diverifikasi lulus. Jalur backend saat ini telah menggunakan dispatcher HTTP bertanda tangan ke webhook OpenBot Jess dan endpoint callback mesin resmi `POST /api/v1/callbacks/qa`.

Dashboard internal untuk membuat job QA, mengirim job ke webhook routine OpenBot Jess, memantau status pengiriman dan eksekusi, menerima hasil callback terautentikasi, serta merekonsiliasi pengiriman yang terputus.

Seluruh persistence melalui **Supabase PostgreSQL** dengan RLS dan RPC atomik (tanpa `service_role`/admin key di runtime). Tidak ada database filesystem atau fallback ke simulator internal. Tanpa konfigurasi dasar Supabase/origin, API mengembalikan `503 SETUP_REQUIRED`; bila konfigurasi webhook belum diisi, pembuatan/pembacaan job dan sesi tetap berjalan sementara aksi pengiriman/callback mengembalikan `503 WEBHOOK_UNCONFIGURED` (tanpa memblokir sesi UI).

## Runtime dan pemeriksaan

Node **22.x**, Next **16.4.6**, React **19.3.1**, TypeScript **5.9.3**, `@supabase/ssr` **0.12.7**, `@supabase/supabase-js` **2.119.2**; versi tepat dan integrity tersedia di lockfile. SDK Supabase memerlukan Node >=22; SSR peer memerlukan supabase-js ^2.114.0 dan pin di atas memenuhi persyaratan tersebut.

Workflow `.github/workflows/ci.yml` menjalankan `npm ci`, pemeriksaan allowlist/lock, typecheck, unit **non-storage**, lalu Next build di GitHub Actions setelah push. Build tidak mengisi key palsu, membuat database, menerapkan migrasi, atau melakukan deployment. Tes unit memeriksa schema, batas request, konfigurasi Supabase & webhook, tanda tangan `x-openbot-*`, verifikasi HMAC/replay callback, origin/Host, dan pemetaan error; **bukan tes transaksi/RLS**. Tes data harus dijalankan di Supabase remote mengikuti [skenario penerimaan](supabase/acceptance.md).

```bash
npm run check:source
npm run check:lock
```

Perintah ringan tersebut memeriksa source/lock secara statis. `node scripts/check-syntax.mjs` hanya transpile/syntax di memori, bukan typecheck penuh. Full install/typecheck/unit/build dijalankan di CI agar tidak membebani mesin development terbatas.

## Setup operator — urutan migrasi dan environment

1. Pastikan project Supabase tujuan menggunakan API URL resmi dari pengaturan project (bukan URL dashboard `supabase.com`).
2. Periksa namespace `public.qa_*` dan riwayat migrasi. Jangan drop/recreate data existing.
3. Jalankan migrasi secara berurutan melalui **Supabase SQL Editor** dengan akun operator berwenang:
   1. `supabase/migrations/001_qa_schema_rls.sql` — tabel dasar, FK komposit, indeks, dan kebijakan RLS.
   2. `supabase/migrations/002_qa_rpc.sql` — helper validasi dan RPC dasar berautentikasi sesi user.
   3. `supabase/migrations/003_qa_webhook.sql` — migrasi aditif untuk integrasi webhook OpenBot Jess: kolom `callback_token_hash` pada `public.qa_jobs`, tabel `public.qa_agent_callback_receipts` ber-RLS, serta RPC `qa_claim_webhook_dispatch`, `qa_record_webhook_outcome`, dan `qa_apply_agent_callback` (`SECURITY DEFINER`, `search_path = ''`).
   > Query daftar/detail job (`Store.list()` dan `Store.job()`) tetap memakai daftar kolom awal sehingga pembacaan job tidak error sebelum operator menjalankan `003_qa_webhook.sql`.
4. Undang pengguna melalui Supabase Auth (matikan self-signup untuk aplikasi internal) dan daftarkan UUID akun aktif ke `public.qa_members`:

```sql
INSERT INTO public.qa_members(user_id, active)
VALUES ('<AUTH_USER_UUID>'::uuid, true)
ON CONFLICT (user_id) DO UPDATE SET active = EXCLUDED.active;
```

5. Pada Vercel, isi environment variables di bawah (cakupan Production/Preview yang sesuai), lalu lakukan redeploy:

| Nama | Wajib | Nilai |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Ya | API origin HTTPS Supabase (`https://<ref>.supabase.co`); tanpa path/query/credentials |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Ya | Publishable key `sb_publishable_…`; jangan pernah gunakan secret/service_role key |
| `QA_APP_ORIGIN` | Ya | Exact origin HTTPS aplikasi (mis. contoh dummy `https://qa.example.invalid`); tanpa trailing slash |
| `QA_WEBHOOK_URL` | Ya (untuk dispatch/callback) | URL HTTPS webhook routine OpenBot Jess tanpa credentials, query string, atau hash |
| `QA_WEBHOOK_SECRET` | Ya (untuk dispatch/callback) | Signing secret non-kosong dari pengaturan OpenBot Routines (`QA Dashboard Webhook`) |
| `QA_CALLBACK_SECRET` | Opsional | Secret khusus derivasi token callback; bila dikosongkan, sistem otomatis menurunkan subkey terpisah domain dari `QA_WEBHOOK_SECRET` memakai `HKDF-SHA256` sehingga `QA_WEBHOOK_SECRET` tidak pernah ikut terkirim keluar |

Template `.env.example` sengaja kosong. Jangan menaruh secret di source code, log, atau chat.

6. Atur Auth **Site URL** dan redirect allowlist di Supabase ke `QA_APP_ORIGIN`. Untuk email undangan, arahkan ke `{{ .SiteURL }}/api/v1/auth/confirm?token_hash={{ .TokenHash }}&amp;type=invite`.

## Kontrak frontend / Auth

Import browser-safe dari `@/contracts`: `SIMULATION_LABEL`, `API_ROOT`, `createJobSchema`, `loginSchema`, `passwordSchema`, `Job`, `CreateJob`, `Result`, `SessionUser`, `SessionResponse`, `ApiError`, `JobResponse`, `JobListResponse`, `isTerminal`, `canReconcile`, dan enum status/deliverables. Jangan import `@/server/**` ke client.

| Endpoint | Request | Response |
|---|---|---|
| GET `/api/v1/auth/session` | Cookie same-origin, no-store | 200 `{user:{id,email},mode:"simulation",storage:"supabase"}` |
| POST `/api/v1/auth/login` | JSON `{email,password}` | 200 SessionResponse + cookie |
| POST `/api/v1/auth/logout` | JSON `{}` | 200 `{signedOut:true}` + clear cookie |
| GET `/api/v1/auth/confirm` | `token_hash` + `type=invite` | Cookie + 303 `/login?invited=1`; token invalid/kedaluwarsa 400 |
| POST `/api/v1/auth/password` | JSON `{password}` + sesi member | 200 `{updated:true}` |

## Kontrak job API v1

| Endpoint | Input | Output |
|---|---|---|
| POST `/api/v1/jobs` | CreateJob + header `Idempotency-Key` UUID v4 | 201 `{job}`; replay identik 200 job terkini; payload beda 409 |
| GET `/api/v1/jobs` | tanpa query | 200 `{mode:"simulation",jobs}` maksimum 100, createdAt desc/jobId desc |
| GET `/api/v1/jobs/{jobId}` | UUID v4 | 200 `{job}`; tidak ada/akun lain 404 |
| POST `/api/v1/jobs/{jobId}/dispatch` | JSON `{}` | 202 `{job}` setelah klaim lease + kirim webhook OpenBot (`not_sent` saja) |
| POST `/api/v1/jobs/{jobId}/retry` | JSON `{}` | 202 `{job}` untuk `failed`/`unknown` atau lease kedaluwarsa; `executionId` tetap |
| POST `/api/v1/jobs/{jobId}/reconcile` | JSON `{}` | 202 `{job}` untuk `unknown`, `accepted` non-terminal, atau `sending` ber-lease kedaluwarsa |
| POST `/api/v1/callbacks/qa` | Header HMAC `x-qa-*` + JSON Callback | 200 `{accepted:true,duplicate,applied}`; mesin-ke-mesin tanpa cookie/`Origin` |
| POST `/api/v1/callbacks/simulator` | tidak aktif | 503 `CALLBACK_DISABLED` |

## Kontrak integrasi Webhook OpenBot Jess & Callback QA

### 1. Outbound Dispatch (QA Dashboard -> OpenBot Webhook Jess)

Saat user memicu `dispatch`, `retry`, atau `reconcile`:
1. Server memvalidasi `readWebhookConfig()` terlebih dahulu sebelum klaim lease DB; bila belum siap, mengembalikan `503 WEBHOOK_UNCONFIGURED` dan status job tetap `not_sent`.
2. Server menurunkan `callbackToken` deterministik 64-hex per `(jobId, executionId)` memakai `HKDF-SHA256` (`info = "qa-dashboard:callback-token:v1:" + executionId`), lalu menyimpan SHA-256 hex-nya (`callback_token_hash`) ke `public.qa_jobs` saat klaim lease (30 detik). Retry/rekonsiliasi pada `executionId` yang sama menghasilkan token identik sehingga tidak membatalkan callback yang sedang berjalan.
3. Server mengirim `POST` ke `QA_WEBHOOK_URL` dengan timeout `15s`, `Content-Type: application/json`, batas `<= 65536` byte:
   - Header:
     - `x-openbot-timestamp`: detik Unix (`String(Math.floor(Date.now() / 1000))`)
     - `x-openbot-delivery-id`: `qa-exec:<executionId>` (dideduplikasi OpenBot dengan status `200` pada pengiriman ulang)
     - `x-openbot-signature`: `sha256=<hex HMAC-SHA256 menggunakan QA_WEBHOOK_SECRET atas "<timestamp>.<deliveryId>.<rawBody>">`
   - Body JSON:

```json
{
  "type": "qa.job.dispatch",
  "occurredAt": "2026-11-26T04:15:00.000Z",
  "data": {
    "schemaVersion": 1,
    "jobId": "<UUIDv4>",
    "executionId": "<UUIDv4>",
    "targetUrl": "https://example.invalid/qa-demo",
    "scope": "Deskripsi cakupan pengujian",
    "acceptanceCriteria": ["Kriteria 1"],
    "deliverables": ["summary", "checks", "findings"],
    "callback": {
      "url": "<QA_APP_ORIGIN>/api/v1/callbacks/qa",
      "token": "<64-hex callbackToken>"
    }
  }
}
```

4. Pemetaan respons HTTP OpenBot:
   - `202` (accepted) atau `200` (duplicate) -> rekam outcome `accepted` (`deliveryStatus = "accepted"`, `executionStatus = "running"` bila belum ada callback), kembalikan `202 { job }`.
   - `400`, `401`, `404`, `413` -> penolakan deterministik sebelum routine jalan; rekam outcome `rejected` (`WEBHOOK_REJECTED`), kembalikan `202 { job }` dengan `deliveryStatus = "failed"` sehingga tombol Retry aktif di UI.
   - `503`, `429`, `5xx`, atau timeout/network error -> rekam outcome `unknown` dan kembalikan `503 RECONCILIATION_REQUIRED`.

### 2. Inbound Callback (Jess -> `POST /api/v1/callbacks/qa`)

Endpoint mesin-ke-mesin memvalidasi `Host === authority(QA_APP_ORIGIN)` tanpa menuntut header browser `Origin` maupun cookie sesi user:
- URL: `<QA_APP_ORIGIN>/api/v1/callbacks/qa` (tanpa query string)
- Method & Header wajib:
  - `Content-Type: application/json` (maks `65536` byte)
  - `x-qa-timestamp`: detik Unix integer (selisih absolut maks `300` detik dari waktu server)
  - `x-qa-signature`: `sha256=<64-hex lowercase HMAC-SHA256 memakai string callback.token sebagai key atas "<x-qa-timestamp>.<exact raw JSON body bytes>">`
- Body JSON (`mode: "agent"`):
  - Progress (`sequence: 1`, opsional sebelum terminal):

```json
{
  "schemaVersion": 1,
  "mode": "agent",
  "eventId": "<UUIDv4 unik per event>",
  "jobId": "<data.jobId>",
  "executionId": "<data.executionId>",
  "sequence": 1,
  "eventType": "running",
  "result": null,
  "error": null
}
```

  - Terminal sukses (`sequence: 2`, `checks` wajib mencakup tepat setiap indeks `0..acceptanceCriteria.length-1` tanpa duplikat):

```json
{
  "schemaVersion": 1,
  "mode": "agent",
  "eventId": "<UUIDv4 unik per event>",
  "jobId": "<data.jobId>",
  "executionId": "<data.executionId>",
  "sequence": 2,
  "eventType": "succeeded",
  "result": {
    "summary": "Ringkasan hasil pengujian QA",
    "checks": [
      { "criterionIndex": 0, "outcome": "pass", "note": "Catatan verifikasi kriteria 0" }
    ],
    "findings": [
      {
        "title": "Judul temuan",
        "steps": "Langkah reproduksi",
        "expected": "Perilaku yang diharapkan",
        "actual": "Perilaku aktual"
      }
    ]
  },
  "error": null
}
```

  - Terminal gagal (`sequence: 2`, bila pengujian gagal dieksekusi):

```json
{
  "schemaVersion": 1,
  "mode": "agent",
  "eventId": "<UUIDv4 unik per event>",
  "jobId": "<data.jobId>",
  "executionId": "<data.executionId>",
  "sequence": 2,
  "eventType": "failed",
  "result": null,
  "error": {
    "code": "AGENT_EXECUTION_FAILED",
    "message": "Penjelasan ringkas kegagalan eksekusi QA"
  }
}
```

- Verifikasi berlapis di server & database:
  1. Route Next.js memverifikasi `x-qa-timestamp` (`<= 300s`) dan `x-qa-signature` memakai `crypto.timingSafeEqual` terhadap token yang diturunkan ulang untuk `(jobId, executionId)`; kegagalan menghasilkan `401 UNAUTHORIZED_CALLBACK`.
  2. RPC `public.qa_apply_agent_callback(p_callback_token, p_event)` mengunci baris `public.qa_jobs` `FOR UPDATE` dan memverifikasi ulang `sha256(p_callback_token) = callback_token_hash` di PostgreSQL (`PT401 UNAUTHORIZED_CALLBACK` bila tidak cocok), sehingga pemegang publishable key tidak dapat memalsukan callback langsung ke PostgREST.
  3. Idempotency dicatat di `public.qa_agent_callback_receipts` per `event_id`: pengulangan `eventId` dengan payload identik mengembalikan `200 {"accepted":true,"duplicate":true,"applied":false}`; `eventId` sama dengan payload berbeda mengembalikan `409 EVENT_CONFLICT`; hasil terminal berbeda pada eksekusi yang sudah terminal mengembalikan `409 TERMINAL_CONFLICT`. Langsung mengirim `sequence: 2` tanpa `sequence: 1` didukung penuh dan otomatis membersihkan lease pengiriman aktif.

## Publikasi source dan pembagian ownership

`node scripts/check-source.mjs` memeriksa allowlist publik (`src`, `supabase`, `scripts`, `tests`, `.github/workflows`, `public`, serta berkas konfigurasi root) dan menolak secret/artefak lokal. Backend memiliki server, contracts, API routes, migrasi SQL, scripts, tests, konfigurasi, workflow, dan README; Frontend memiliki halaman UI, layout, CSS, komponen client, dan aset publik.
