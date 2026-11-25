# QA Dashboard

**SIMULASI AGENT — bukan integrasi QA OpenBot; penyimpanan Supabase**

Dashboard internal untuk membuat job dummy, melihat status dan hasil, serta merekonsiliasi pekerjaan yang terputus. Target URL hanya disimpan; tidak dikunjungi, tidak ada crawling atau pengiriman job ke agent QA nyata. Hasil `pass` adalah hasil dummy simulator, bukan keputusan bahwa situs lulus QA.

Seluruh persistence melalui **Supabase PostgreSQL**. Tidak ada database filesystem atau fallback. Tanpa konfigurasi, API mengembalikan `503 SETUP_REQUIRED`; tanpa migrasi/akses, operasi gagal dengan pesan aman. Build shell tanpa konfigurasi tidak membuktikan koneksi data.

## Runtime dan pemeriksaan

Node **22.x**, Next **16.4.6**, React **19.3.1**, TypeScript **5.9.3**, `@supabase/ssr` **0.12.7**, `@supabase/supabase-js` **2.119.2**; versi tepat dan integrity tersedia di lockfile. SDK Supabase memerlukan Node >=22; SSR peer memerlukan supabase-js ^2.114.0 dan pin di atas memenuhi persyaratan tersebut.

Workflow `.github/workflows/ci.yml` menjalankan `npm ci`, pemeriksaan allowlist/lock, typecheck, unit **non-storage**, lalu Next build di GitHub Actions setelah push. Build tidak mengisi key palsu, membuat database, menerapkan migrasi, atau melakukan deployment. Tes unit hanya memeriksa schema, batas request, konfigurasi, origin/Host dan error; **bukan tes transaksi/RLS**. Tes data harus di Supabase remote khusus uji, mengikuti [skenario penerimaan](supabase/acceptance.md).

```bash
npm run check:source
npm run check:lock
```

Perintah ringan tersebut memeriksa source/lock secara statis. `node scripts/check-syntax.mjs` hanya transpile/syntax di memori, bukan typecheck penuh. Full install/typecheck/unit/build dijalankan di CI agar tidak membebani mesin development terbatas. Jangan menganggap workflow yang baru ditulis sudah lulus.

## Setup operator — sebelum digunakan

1. Siapkan **project Supabase khusus uji** untuk Preview. Jangan memakai data existing untuk acceptance. Pastikan project tujuan dan API URL dari pengaturan Supabase; URL dashboard Supabase bukan API URL.
2. Periksa namespace `public.qa_*` dan riwayat migrasi. Jika sudah ada objek dengan nama sama, hentikan dan review kompatibilitas; jangan drop/recreate. SQL ini migration satu kali, bukan skrip reset atau upsert schema.
3. Review lalu jalankan `supabase/migrations/001_qa_schema_rls.sql`, kemudian `002_qa_rpc.sql` melalui **Supabase SQL Editor** dengan akun operator yang berwenang. Masing-masing satu transaksi, tanpa jendela tabel terbuka. Key publishable tidak dapat menerapkan DDL. Jangan memasukkan akses operator/admin ke runtime aplikasi.
4. Undang pengguna melalui Supabase Auth. Untuk project dedicated aplikasi internal, matikan self-signup; bila project dibagi dengan aplikasi lain, review dampaknya sebelum mengubah pengaturan global Auth.
5. Tambahkan UUID akun Auth yang sudah diundang ke `public.qa_members` melalui operator. Contoh template (ganti placeholder, jangan jalankan apa adanya):

```sql
INSERT INTO public.qa_members(user_id, active)
VALUES ('<AUTH_USER_UUID>'::uuid, true)
ON CONFLICT (user_id) DO UPDATE SET active = EXCLUDED.active;
```

Hanya operator yang mengelola keanggotaan. Untuk mencabut akses, operator dapat menetapkan `active=false`; permintaan data/RPC berikutnya akan ditolak. Semua tabel mengaktifkan RLS. Pengguna hanya SELECT data miliknya saat membership aktif; anon tidak dapat membaca/mutasi. Tidak ada grant/policy direct INSERT/UPDATE/DELETE untuk client. Mutasi lewat RPC terkontrol dengan membership dan ownership eksplisit.

6. Pada Vercel, isi tiga environment variables dengan nilai nyata dari project/settings, cakupan Preview/Production yang benar:

| Nama | Nilai |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | API origin HTTPS Supabase (bukan URL dashboard); tanpa path/query/credentials |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key `sb_publishable_…`; bukan key admin/legacy JWT |
| `QA_APP_ORIGIN` | Exact origin HTTPS aplikasi, contoh **dummy** `https://qa.example.invalid`; tanpa trailing slash/path |

Template `.env.example` sengaja kosong. Jangan mengirim key/password melalui chat, menaruhnya di source/log, atau memakai key berhak admin untuk aplikasi. Prefix `NEXT_PUBLIC_` hanya untuk dua konfigurasi publishable tersebut; tidak untuk secret. Environment tidak dibaca saat import modul atau prerender shell. Setelah mengubah environment, pengguna melakukan deployment baru. Tidak ada koneksi yang otomatis diuji saat build.

7. Atur Auth **Site URL** ke origin yang sama dan redirect allowlist ke URL aplikasi yang disepakati. Gunakan domain Preview stabil/branch domain yang tepat agar `QA_APP_ORIGIN` dan Host sama; jangan percaya arbitrary forwarded headers atau menambahkan wildcard ke validasi server. Bila deployment berganti domain, operator perlu mengubah konfigurasi origin dan Auth untuk domain baru.
8. Untuk invitation, review template email undangan Supabase agar menuju route confirm server:

```html
<a href="{{ .SiteURL }}/api/v1/auth/confirm?token_hash={{ .TokenHash }}&amp;type=invite">Terima undangan</a>
```

Route menerima `type=invite` saja, memverifikasi token ke Supabase Auth, memeriksa membership, memasang cookie, lalu redirect tetap ke `/login?invited=1`. Tidak ada parameter redirect bebas. Pada halaman undangan, UI dapat menawarkan password baru melalui endpoint password (minimum 12 karakter + kebijakan Supabase). Jangan menyimpan password di sessionStorage/log. Tidak ada signup atau pemulihan password publik pada scope ini; bantuan akun melalui operator.
9. Pengguna import repository aplikasi ke Vercel dengan preset Next.js, root folder berisi package.json, Node 22, perintah build default `npm run build`. Deployment dan auto-deploy dikelola pengguna. Source perlu review UI/integrasi sebelum deployment diterima; CI hijau hanya gerbang build.

## Kontrak frontend / Auth

Import browser-safe dari `@/contracts`: `SIMULATION_LABEL`, `API_ROOT`, `createJobSchema`, `loginSchema`, `passwordSchema`, `Job`, `CreateJob`, `Result`, `SessionUser`, `SessionResponse`, `ApiError`, `JobResponse`, `JobListResponse`, `isTerminal`, `canReconcile`, dan enum status/deliverables. Jangan import `@/server/**` ke client.

| Endpoint | Request | Response |
|---|---|---|
| GET `/api/v1/auth/session` | Cookie same-origin, no-store | 200 `{user:{id,email},mode:"simulation",storage:"supabase"}` |
| POST `/api/v1/auth/login` | JSON `{email,password}` | 200 SessionResponse + cookie; login/membership gagal tanpa data job |
| POST `/api/v1/auth/logout` | JSON `{}` | 200 `{signedOut:true}` + clear cookie; session lokal aplikasi ditutup |
| GET `/api/v1/auth/confirm` | `token_hash` + `type=invite` dari email saja | Cookie + 303 `/login?invited=1`; token invalid/kedaluwarsa 400 |
| POST `/api/v1/auth/password` | JSON `{password}` + sesi member | 200 `{updated:true}`; gagal aman 400 |

Semua route session dan data membuat **client SSR per request**. `getUser()` mengonfirmasi identitas ke Auth, dilanjutkan SELECT membership lewat RLS. `getSession()` tidak dipakai untuk authorization. Adapter cookie SSR memakai `getAll/setAll`, meneruskan cookie dan cache headers dari SDK termasuk saat error; cookie Secure, HttpOnly, SameSite=Lax, Path=/. Tidak ada browser SDK/token yang perlu dibaca JavaScript.

UI merupakan shell client; semua data terlindungi di API. Tidak diperlukan Proxy refresh ganda karena tidak ada Server Component yang membaca session/data: request session/data mengerjakan refresh dan menulis cookie. Bila nanti ditambahkan pembacaan auth dalam Server Components, tambahkan Proxy resmi Supabase dengan penerusan cookie/cache headers terlebih dahulu; jangan membuat singleton session global.

UI harus memanggil session terlebih dahulu, menampilkan setup state pada 503, login state pada 401, dan akses belum diizinkan pada 403. Setelah login, scope pending create ke **`user.id`**; jangan pakai satu key global antar pengguna. Pertahankan Idempotency-Key + payload untuk submit yang responsnya hilang. Pada logout/session expired, hentikan polling, buang jobs/detail/pending milik akun lama sebelum menampilkan akun lain. Jangan menyimpan kredensial/session token sendiri. Semua fetch menggunakan path relatif, cookie same-origin dan `cache:"no-store"`.

## Kontrak job API v1

| Endpoint | Input | Output |
|---|---|---|
| POST `/api/v1/jobs` | CreateJob + header `Idempotency-Key` UUID v4 | 201 `{job}`; replay identik 200 job terkini; payload beda 409 |
| GET `/api/v1/jobs` | tanpa query | 200 `{mode:"simulation",jobs}` maksimum 100, createdAt desc/jobId desc |
| GET `/api/v1/jobs/{jobId}` | UUID v4 | 200 `{job}`; tidak ada/akun lain 404 |
| POST `/api/v1/jobs/{jobId}/dispatch` | JSON `{}` | 202 `{job}`; initial not_sent saja |
| POST `/api/v1/jobs/{jobId}/retry` | JSON `{}` | 202 `{job}`; failed/unknown atau lease pengiriman kedaluwarsa; identity tetap |
| POST `/api/v1/jobs/{jobId}/reconcile` | JSON `{}` | 202 `{job}`; unknown, accepted/running yang tertunda, sending dengan lease kedaluwarsa |
| POST `/api/v1/callbacks/simulator` | tidak aktif | 503 `CALLBACK_DISABLED`; bukan jalur callback OpenBot |

Seluruh job/data memerlukan Auth + membership aktif. Semua mutasi browser wajib JSON, Host tepat sama dengan authority `QA_APP_ORIGIN`, Origin tepat sama dengan origin tersebut. **Origin internal `request.url` Next tidak dibandingkan dengan domain publik**; pathname tetap dipakai untuk routing, arbitrary X-Forwarded-* tidak dipercaya. Tidak ada CORS wildcard. Control ini tidak menggantikan Auth/RLS. Batas body aktual stream 64 KiB; unknown field/schema/JSON invalid 400, media 415, oversize 413. Kontrak URL menggunakan grammar HTTP(S) konservatif tanpa userinfo/whitespace; tidak di-fetch.

Contoh **dummy**, bukan hasil QA:

```json
{
  "schemaVersion": 1,
  "targetUrl": "https://example.invalid/qa-demo",
  "scope": "Dummy simulator",
  "acceptanceCriteria": ["Dummy criterion"],
  "deliverables": ["summary", "checks", "findings"]
}
```

Job mempertahankan identitas dan field kontrak awal, ditambah `leaseExpiresAt:string|null`. `deliveryStatus` dan `executionStatus` tetap terpisah. `result` dan `lastError` nullable. 202 hanya berarti request pengiriman selesai dicatat, bukan keputusan QA. Hasil memuat summary/checks/findings dummy. Tampilkan banner `SIMULATION_LABEL` permanen, hasil sebagai teks, state loading/empty/validation/network/stale. Polling 2 detik hanya selama nonterminal dan sesi aktif; jangan regresikan versi/selection akibat respons lama.

Rekonsiliasi merupakan aksi baru yang tidak membuat job/execution baru. Gunakan `canReconcile(job)` untuk affordance UI; keputusan lease tetap memakai waktu **database**, bukan jam browser. Selama lease aktif, aksi lain 409 `DISPATCH_IN_PROGRESS`. UI dapat menunggu/refresh lease, tidak membuat create key atau execution baru untuk mengatasi konflik. Terminal tidak dibuka ulang; retest/new execution di luar scope.

Error selalu `{error:{code,message,requestId}}` tanpa stack/raw provider payload. Kode utama: 401 AUTH_REQUIRED/INVALID_CREDENTIALS; 403 MEMBERSHIP_REQUIRED/HOST_NOT_ALLOWED/ORIGIN_NOT_ALLOWED/ACCESS_DENIED; 404 JOB_NOT_FOUND; 409 IDEMPOTENCY_CONFLICT/DISPATCH_IN_PROGRESS/ACTION_NOT_ALLOWED/TERMINAL_JOB/EVENT_CONFLICT; 503 SETUP_REQUIRED/DATABASE_UNAVAILABLE/AUTH_UNAVAILABLE/RECONCILIATION_REQUIRED/CALLBACK_DISABLED. Pada 503 setelah mutasi, outcome dapat sudah commit: refresh dan reconcile/replay identity yang sama. Jangan mengubah network error menjadi status sukses.

## Batas transaksi dan keamanan data

Migrasi `001` membuat 7 tabel `qa_*` dengan composite FK owner/job/execution, constraints, indeks dan RLS. `002` mendefinisikan 7 RPC mutasi: create_job, claim_dispatch, record_outcome, sim_accept, sim_complete, apply_sim_callback, mark_outbox_delivered. Semua public mutator SECURITY DEFINER memakai `search_path=''`, tabel fully qualified, membership/session/ownership eksplisit. EXECUTE PUBLIC/anon dicabut, authenticated hanya diberi RPC yang diperlukan; helper private tidak dapat dieksekusi client. Operator migrasi adalah owner terpercaya; runtime tidak menggunakan akses operator.

- Create key scope user + operation, fingerprint **JSONB database** SHA-256 (object order ternormalisasi, array order tetap). Advisory transaction lock + unique constraint menyimpan key/job atomik.
- Claim memakai row lock, attempt UUID dan lease **30 detik dari clock database**. Claim lease kedaluwarsa ditandai memerlukan rekonsiliasi; unknown tetap visible selama belum ada bukti callback. Tidak ada recovery massal saat cold start.
- Record outcome hanya memutasi job jika attempt masih aktif dan lease belum kedaluwarsa; stale attempt no-op. Callback/terminal lebih kuat daripada ACK/transport error.
- Inbox acceptance, complete, callback dan mark delivered adalah **RPC/transaksi terpisah**. Complete mengunci inbox dan commit count<=1 + result + outbox bersama. Callback wajib identik dengan event outbox tersimpan; browser tidak dapat menyuntikkan arbitrary result. Receipt + status + result satu transaksi. Mark delivered hanya sesudah receipt ada.
- Simulator dipanggil internal **secara awaited**, tanpa HTTP self-call, background worker, cron atau fire-and-forget. Lookup gagal tidak dianggap not_found. Rekonsiliasi melanjutkan inbox/outbox tersimpan dengan executionId yang sama. Permintaan yang terputus dapat meninggalkan lease/pending work; aksi manual berikutnya memulihkan setelah lease berakhir.
- Outbox terminal yang receipt-nya sudah commit tetapi delivery marker hilang aman untuk replay operator/harness; receipt mencegah penulisan ulang hasil. UI tidak membuka terminal kembali. Count mengukur efek logis simulator dalam Supabase, **bukan exactly-once end-to-end** atau QA nyata.
- Tidak ada upload bukti file/video, machine callback auth, agent tujuan atau integrasi OpenBot pada tahap ini. Tidak ada koneksi Supabase/Vercel yang diklaim terverifikasi sebelum acceptance remote dan UI lulus.

## Publikasi source dan handoff

`node scripts/check-source.mjs` memakai allowlist `src`, `supabase`, `scripts`, `tests`, `.github/workflows`, `public` dan file config/README yang eksplisit. Tidak memasukkan env aktual, data/artefak historis, build output, dependency terinstal atau instruksi internal. Scan pola secret bukan audit lengkap; reviewer wajib memeriksa berkas sebelum commit/push. Jangan menyalin seluruh workspace. Data historis dipertahankan di mesin dan tidak dipakai runtime baru.

Source UI sudah mencakup login/session, label simulasi, pending-create per user, dan Rekonsiliasi. Backend memiliki server/contracts/API/SQL/scripts/tests/package/config/workflow/README; Frontend memiliki page/layout/CSS/components/public/login page. Kebutuhan dependency/config/API melalui Backend. Build cloud, render UI, dan pengujian remote merupakan gerbang berbeda; deployment dilakukan pengguna.

Referensi resmi: [Supabase SSR](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs), [Auth getUser](https://supabase.com/docs/reference/javascript/auth-getuser), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [database functions/privileges](https://supabase.com/docs/guides/database/functions), serta panduan Route Handlers/Proxy dari dokumentasi Next yang terpasang. Panduan ini bukan bukti bahwa migrasi atau deployment telah dijalankan.
