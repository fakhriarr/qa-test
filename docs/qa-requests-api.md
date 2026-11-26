# Kontrak Backend QA Dashboard PRD v1.0

Semua path diawali `/api/v1`. Endpoint pengguna memakai sesi dashboard dan akun internal aktif. Mutasi browser memakai `Origin` yang sama dengan origin dashboard. API memakai respons JSON tanpa cache, kecuali unduhan yang berisi byte file. Error berbentuk `{"error":{"code":"DRAFT_CONFLICT","message":"…","requestId":"…"}}`.

## Draf, submit, dan discovery

| Method dan path | Request | Respons dan tindakan |
|---|---|---|
| `GET /drafts` | — | `200 {"drafts":[…]}`, hingga 100 draf belum disubmit, terbaru dulu |
| `POST /drafts` | Header `Idempotency-Key` UUID v4 dan objek data draf langsung. `{}` valid. | `201 {"draft":…}`. Replay sebelum draf berubah `200`. Gunakan key baru untuk draf baru. |
| `GET /drafts/{draftId}` | — | `200 {"draft":…}`, termasuk `jobId` setelah submit |
| `PUT /drafts/{draftId}` | `{"revision":1,"data":{…}}` | `200 {"draft":…}`. Mengganti seluruh data draf dan mengembalikan revisi berikutnya. |
| `POST /drafts/{draftId}/submit` | `{"revision":2}` | `200 {"job":…}`. Membekukan draf dan membuat job `not_sent` beserta itemnya dalam satu transaksi. Replay revisi yang sama mengembalikan job yang sama. |
| `POST /discovery` | `{"targetUrl":"https://shop.example/"}` | `200 {"candidates":[…]}`. `422 DISCOVERY_TARGET_DENIED` atau `DISCOVERY_UNAVAILABLE` berarti lanjut dengan URL manual. |
| `POST /jobs/{jobId}/dispatch` | `{}` | `202 {"job":…}`. Panggil setelah submit saat pengguna menekan **Kirim ke QA**. Jika job sudah dibuat tetapi langkah kirim gagal, muat status job. |
| `POST /jobs/{jobId}/retry`, `/reconcile` | `{}` | `202 {"job":…}`. Pakai aturan lease, rekonsiliasi, dan retry lama. Eksekusi dan ID item tetap. |
| `GET /jobs`, `GET /jobs/{jobId}` | — | Respons job lama tetap kompatibel. Ambil detail permintaan dan progres dari endpoint deliverables. |

Contoh draf parsial sintetis:

```json
{
  "draftId": "c19597fd-1f36-4e6d-a64f-6af6dfb79a69",
  "revision": 1,
  "jobId": null,
  "updatedAt": "2026-11-26T02:00:00Z",
  "data": { "targetUrl": "https:", "environment": "staging" }
}
```

Contoh data lengkap sebelum submit:

```json
{
  "targetUrl": "https://shop.example/",
  "environment": "staging",
  "accessRequiresLogin": true,
  "accessNotes": "Minta akun uji lewat kanal internal.",
  "scopeUrls": ["https://shop.example/cart"],
  "acceptanceCriteria": ["Keranjang kosong menampilkan pesan yang jelas."],
  "suggestions": "Periksa tampilan kosong.",
  "prohibitions": "Jangan melakukan transaksi.",
  "deliverables": ["test_plan", "test_case", "automation_script"]
}
```

| Field | Validasi saat submit |
|---|---|
| `targetUrl` | URL HTTP(S) absolut, maksimal 2.048 karakter, tanpa userinfo atau fragmen |
| `environment` | `development`, `staging`, `production`, atau `other` |
| `accessRequiresLogin` | Boolean opsional. Default submit dan resume jika absen adalah `false`. |
| `accessNotes` | Teks nonrahasia opsional, maksimum 1.000 karakter. Default submit dan resume jika absen adalah `""`. |
| `scopeUrls` | 1–12 URL HTTP(S) unik setelah normalisasi, aturan URL sama. Manual dan discovery memakai field yang sama. |
| `acceptanceCriteria` | 1–10 teks, masing-masing 1–500 karakter setelah pemangkasan spasi |
| `suggestions`, `prohibitions` | Opsional, masing-masing maksimal 2.000 karakter dan default string kosong |
| `deliverables` | 1–7 jenis unik dari katalog |

Draf menerima isian parsial, termasuk URL yang belum selesai diketik. Field di luar skema ditolak, termasuk password dan token. Isi `accessNotes` hanya dengan instruksi proses, misalnya “Minta akun uji lewat kanal internal”. API menolak pola umum kredensial, tetapi teks bebas tetap harus bebas rahasia. Kirim kedua field di objek POST draf, atau di `data` pada PUT. Baca ulang dari `draft.data` saat resume dan `request` saat detail. Keduanya diteruskan pada `data.request` saat dispatch; indikator akses tidak mengubah discovery publik. Batas body JSON 64 KiB berlaku untuk request ini. `400 INVALID_REQUEST` berarti bentuk atau isi belum sah. `404 DRAFT_NOT_FOUND` juga berlaku untuk draf milik akun lain. `409 DRAFT_CONFLICT` berarti data berubah atau draf sudah disubmit. Pertahankan isian lokal dan muat revisi server sebelum mencoba menyimpan lagi.

Discovery hanya mengambil satu dokumen HTML publik HTTPS pada port standar, tanpa query pada URL awal, tanpa mengikuti redirect, tanpa sesi target, dan tanpa membuka tautan hasil. DNS IPv4 dipastikan publik dan alamat koneksi dipatok. Batas 4 detik, 256 KiB HTML, dan 40 kandidat satu origin. Filter memakai markup HTML statis dan dapat melewatkan tautan yang dibuat JavaScript atau menyertakan tautan yang disembunyikan stylesheet eksternal. Kandidat hanya saran cakupan dan pengguna tetap bisa menambahkan URL manual.

## Katalog dan hasil

| ID | Label | Format |
|---|---|---|
| `test_plan` | Test Plan | Markdown |
| `test_case` | Test Case | CSV |
| `api_report` | API Report | Markdown |
| `automation_script` | Automation Script | ZIP |
| `security_report` | Security Report | Markdown |
| `performance_report` | Performance Report | Markdown |
| `bug_report` | Bug Report | Markdown |

`GET /jobs/{jobId}/deliverables` mengembalikan `{request,items,ready,total,partial}`. `request` berisi data submit dan `null` untuk job lama. Job lama menghasilkan `items: []` dan tetap menampilkan hasil JSON dari `GET /jobs/{jobId}`. Respons contoh untuk job yang masih berlangsung:

```json
{
  "request": {
    "targetUrl": "https://shop.example/",
    "environment": "staging",
    "accessRequiresLogin": false,
    "accessNotes": "",
    "scopeUrls": ["https://shop.example/cart"],
    "acceptanceCriteria": ["Keranjang kosong menampilkan pesan yang jelas."],
    "suggestions": "",
    "prohibitions": "",
    "deliverables": ["test_plan", "test_case"]
  },
  "items": [
    {
      "deliverableId": "ded1f1ed-645a-461a-8bca-784ace3843e3",
      "kind": "test_plan",
      "status": "ready",
      "fileName": "plan.md",
      "sizeBytes": 17,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "readyAt": "2026-11-26T02:05:00Z",
      "downloadUrl": "/api/v1/jobs/ce5aafff-cfac-4608-bd70-8777673dc775/deliverables/ded1f1ed-645a-461a-8bca-784ace3843e3"
    },
    {
      "deliverableId": "eb793810-61b9-44a3-a976-548fa43bff23",
      "kind": "test_case",
      "status": "pending",
      "fileName": null,
      "sizeBytes": null,
      "sha256": null,
      "readyAt": null,
      "downloadUrl": null
    }
  ],
  "ready": 1,
  "total": 2,
  "partial": false
}
```

Tampilkan unduhan saat `status: "ready"`, termasuk saat job masih berjalan. Saat eksekusi terminal, item yang belum siap dilaporkan `failed`. `partial` bernilai true untuk eksekusi terminal dengan setidaknya satu file siap dan satu file belum siap. Retry terhadap file yang sudah direservasi dapat memulihkan item sesudah callback terminal. `GET /jobs/{jobId}/deliverables/{deliverableId}` mengembalikan attachment hanya kepada pemilik dan `404 ARTIFACT_NOT_FOUND` untuk akun lain, item yang belum siap, atau pasangan ID yang salah. UI bisa membuka tautan unduhan langsung dari origin dashboard.

## Kontrak penerima dispatch dan pengirim file

Payload webhook lama tetap memakai `data.schemaVersion: 1`, field job lama, dan `data.callback`. Dispatch untuk permintaan baru juga memiliki `data.request` dengan `environment`, `accessRequiresLogin`, `accessNotes`, `scopeUrls`, `suggestions`, `prohibitions`, `securityPolicy: "defensive_only"`, dan `deliverables: [{deliverableId,kind,uploadUrl,uploadToken}]`. Target dan kriteria tetap ada di `data.targetUrl` dan `data.acceptanceCriteria`. Pemeriksaan keamanan hanya defensif. Callback JSON ke `POST /callbacks/qa` memakai tanda tangan, schema dan urutan lama.

Kirim satu `PUT multipart/form-data` ke `uploadUrl` dengan `Authorization: Bearer <uploadToken>`. Field yang diterima tepat satu `file` (nama dari part file) dan satu `sha256` (64 karakter hex lowercase). Ukuran berasal dari byte yang diterima dan dibandingkan dengan batas aplikasi 3 MiB per file, 3 MiB + 16 KiB untuk multipart termasuk overhead. Format diperiksa dari ekstensi dan isi UTF-8/CSV/struktur ZIP. File disajikan sebagai attachment dan ZIP tidak diekstrak oleh dashboard. Batas transport Vercel dan integrasi pengirim belum teruji.

Sukses mengembalikan `200 {"deliverable":{…},"replay":false}`. Pengiriman ulang dengan nama dan byte yang sama mengembalikan metadata yang sama. File berbeda untuk item yang sudah direservasi mengembalikan `409 ARTIFACT_CONFLICT`. Ulangi pengiriman dengan file dan nama yang sama untuk kegagalan sementara. `401 UNAUTHORIZED_CALLBACK`, `404 ARTIFACT_NOT_FOUND`, `409 ARTIFACT_EXECUTION_INACTIVE`, `400 INVALID_MULTIPART` atau `CHECKSUM_MISMATCH`, `413 BODY_TOO_LARGE`, `415 MULTIPART_REQUIRED` atau `INVALID_ARTIFACT_FORMAT`, dan `503 ARTIFACT_STORAGE_UNAVAILABLE` perlu ditangani pengirim. Batas 65.536 byte tetap berlaku untuk webhook masuk dan callback JSON lama.

## Setup dan verifikasi staging

- Gunakan migrasi 004 versi revisi ini di staging setelah 003. Migrasi sebelumnya belum dijalankan dalam penugasan ini. Aplikasi menggunakan publishable key dan sesi akun untuk RPC draf serta unduhan. Token webhook dan callback yang sudah ada tetap dipakai untuk autentikasi callback; dari material callback, server menurunkan capability Storage terpisah per job, eksekusi, dan item. Postgres menyimpan hash capability di tabel tertutup. Dashboard meneruskannya hanya ke REST/Storage Supabase melalui header internal; pengirim tetap memakai bearer token unggah dashboard. RLS mengizinkan operasi standar hanya untuk path item yang direservasi, dan menolak list, signed URL, overwrite, serta delete di bucket. Uji bahwa layanan Storage staging meneruskan header ke RLS dan mengenali nama operasi. [Sumber Storage](https://github.com/supabase/storage/blob/master/src/internal/database/postgres/scope.ts) · [Operasi RLS Storage](https://supabase.com/docs/guides/storage/schema/helper-functions#storageallow_only_operation)
- Pakai dua akun internal staging A dan B serta penerima webhook tiruan. Buat draf A, logout/login, dan cek data tersimpan. Pastikan kedua field akses kembali saat resume dan muncul dalam payload ke penerima tiruan. Coba simpan field password, serta petunjuk yang berisi pola token yang dikenali, dan pastikan API serta RPC langsung menolak. Pastikan B menerima 404 dari detail draf dan job A. Submit revisi yang sama dua kali dan konfirmasi kedua respons mengembalikan job yang sama. Kirim dua PUT draf dari revisi yang sama dan periksa hanya satu yang berhasil.
- Dispatch tiga item sintetis ke penerima tiruan. Siapkan `plan.md` berisi `# Synthetic plan`, `cases.csv` dengan baris header `id,expected` dan baris data `1,empty`, dan `script.zip` berisi satu `note.txt` tanpa script aktif. Hitung SHA-256 masing-masing sebelum unggah. Pakai callback `running` lama ketika job berjalan.
- Unggah Markdown dan pastikan A bisa mengunduh byte yang sama saat CSV dan ZIP masih pending. B harus mendapat 404 untuk URL API yang sama dan tidak dapat membaca metadata via REST atau file dari bucket via Storage API. Uji juga Storage anonim tanpa capability, penggunaan token unggah Dashboard langsung ke Storage, capability item A terhadap path item B, dan penolakan signed URL serta list.
- Ulangi Markdown serial dan paralel, lalu kirim varian byte dengan checksum sendiri. Hasil yang diharapkan adalah satu objek asli, satu baris siap, dan konflik untuk varian. Simulasikan timeout setelah objek tersimpan sebelum finalize dan ulangi byte yang sama untuk memulihkan metadata. Coba token item pada item lain, ukuran berlebih, format salah dan checksum salah.
- Unggah CSV dan ZIP, bandingkan checksum unduhan dengan fixture, lalu kirim callback terminal JSON lama. Pada eksekusi sintetis terpisah, kirim callback terminal setelah hanya satu item siap dan cek `partial: true` serta akses file pertama. Gunakan server HTML staging yang terotorisasi untuk cek satu request HTTPS, tidak ada redirect yang diikuti, dan fallback manual saat discovery gagal.
- Bukti sebelum rilis mencakup status HTTP, checksum, jumlah objek/baris, hasil akses dua akun, dan batas ukuran aktual. Jangan gunakan data produksi. Integrasi pengirim Jess perlu koordinasi dan verifikasi terpisah.
