# Acceptance Supabase remote — PENDING

**SIMULASI AGENT — bukan integrasi QA OpenBot; penyimpanan Supabase**

Belum dijalankan. Hanya setelah operator menyiapkan project **remote khusus tes**, migrasi, dua member Auth aktif A/B, satu Auth nonmember C, dan akses anon publishable. Jangan pakai data existing/production, jangan jalankan pada database lokal, dan jangan menjalankan SQL Editor sebagai postgres lalu menyebutnya bukti RLS authenticated. Uji dengan session caller yang sebenarnya pada dua SDK client/instance terpisah. Simpan token/password di secret store/environment aman, tidak dalam source/output. Tidak ada cleanup data otomatis.

Catat tiap skenario: command/aksi tepat, peran/session label (tanpa token), job/attempt/execution/event dummy, expected/actual HTTP/RPC + state sebelum/sesudah, logical count, serta exit/status. Belum ada hasil LULUS untuk tabel di bawah.

| Kasus | Langkah / fault boundary | Expected |
|---|---|---|
| Setup kosong | Deploy shell tanpa 3 env, buka session/jobs | 503 SETUP_REQUIRED, tidak ada success palsu atau data alternatif |
| Migration/schema gate | Operator review 001/002, apply sekali di test project baru; periksa ACL/RLS/FK/check | 7 tabel RLS, anon tidak SELECT/EXECUTE; hanya SELECT direct bagi member; helper EXECUTE private |
| Auth boundary | A/B diundang dan allowlisted; C login tanpa membership, anon/no session, malformed/expired cookie | A/B hanya data sendiri; C 403; anon/invalid session 401; refresh/session cookie no-store; no secret log |
| Direct table writes | A/anon mencoba insert/update/delete semua tabel, termasuk qa_members | Ditolak grant/policy; helper RPC juga ditolak; operator tetap jalur membership |
| Ownership silang | A membuat job, B GET/RPC claim/accept/complete/callback/mark milik A | 404 atau permission denied tanpa mutasi/kebocoran result; B list kosong untuk job A |
| Atomic create | Dua client A memanggil qa_create_job dengan p_key/p_input identik bersamaan; replay setelah respons hilang; key sama payload beda | 1 job/execution/key; replay job terkini; konflik 409; array order berbeda adalah konflik |
| Claim/concurrency | Dua client A qa_claim_dispatch(p_job_id,false,false) serentak | Satu attempt/lease menang, lainnya 409 DISPATCH_IN_PROGRESS; lease memakai clock DB +30s |
| Lease expiry/fencing | Claim A1, hentikan request sebelum accept; setelah >30s DB clock, reconcile claim A2; kirim qa_record_outcome A1 terlambat | A2 requiresReconciliation true; lookup dahulu; A1 applied false dan tidak menimpa state/activeAttempt A2 |
| Lost claim/outcome response | Buang respons setelah RPC commit, bukan rollback | Lease/job tetap; refresh/reconcile memakai identity sama; tidak ada mass recovery cold start |
| Reject-before-accept | Pada test harness caller A, record_outcome(p_job_id,A1,'rejected') sebelum sim_accept; lanjut retry | failed+error terlihat; retry tetap executionId, complete count=1 |
| ACK hilang | Claim→sim_accept→sim_complete, putus sebelum outcome/callback; setelah lease ulang reconcile | lookup accepted/terminal, resume outbox, bukan execution baru; logical count 1 |
| Pending accepted/running | Putus setelah record accepted atau callback running, sebelum terminal/mark | Tombol Rekonsiliasi melanjutkan stored inbox/outbox; tidak membuat job/compute effect baru |
| Callback sebelum ACK | Apply event running/terminal sebelum record_outcome accepted/unknown | Terminal/result/error tidak regresi; delivery accepted; outcome fenced |
| Callback replay/out-of-order | Ambil body dari outbox A melalui RLS; terminal seq2 dahulu lalu running seq1; ulang event yang sama | seq1 late receipt no-op; replay duplicate true/applied false; version/result terminal tidak berubah |
| Event/payload conflict | Ubah body stored event saat memanggil callback (same ID), ganti execution/job, atau arbitrary new event ID | 409 EVENT_CONFLICT/EXECUTION_MISMATCH atau 404 EVENT_NOT_FOUND; tidak ada hasil arbitrary. Terminal berbeda tidak last-write-wins |
| No delivery marker before receipt | Panggil qa_mark_outbox_delivered sebelum apply; kemudian apply, buang respons, replay apply lalu mark | Awal 409 RECEIPT_REQUIRED; replay no-op; marker true hanya setelah receipt persisten |
| Cross-instance persistence | Sim_accept pada client1, close client/request, complete/callback/reconcile pada client2 | Inbox/outbox/result/receipt bertahan; tidak bergantung pada process memory |
| Partial failure/rollback | Di project tes saja, operator memasang fault transaction-local yang memaksa kegagalan pada insert create-key/outbox/receipt; jangan publikasikan bypass fixture | Create-key+job, complete count/result+outbox, callback receipt+job/result masing-masing rollback atomik |
| SQL boundary | Direct RPC input unknown fields, malformed JSON types/criteria/deliverables, invalid UUID, callback bad checks/sequence | Error 400 atau UUID cast validation, tidak ada mutasi; autentikasi/membership tetap wajib |
| API Host/Origin | Domain app exact; internal Request URL berbeda; Host salah dengan forwarded-host benar; Origin salah/null/hilang pada POST | Host exact + Origin exact berhasil; spoofed Host/Origin 403; forwarded headers bukan trust source; no wildcard CORS |
| Config outage | Key/API URL salah, DB timeout, migrasi belum ada, lookup unavailable | Pesan aman 503/akses ditolak; tidak mengklaim not_found/sukses, tidak mengganti execution |
| UI flow | Login→create tanpa auto-dispatch→dispatch/reconcile→hasil; logout/login B; stale/network/409 | Banner baru, status terpisah, checks pada job benar, tidak ada data/pending A terlihat pada B; hasil tetap dummy |

Untuk rollback injection, perubahan fixture hanya melalui operator dan harus dibatasi ke transaksi/dataset test; ini memerlukan review tersendiri. Dokumen ini tidak memberi izin merusak data existing. Uji durability lintas server/power loss dan integrasi agent/machine callback nyata tetap di luar scope.
