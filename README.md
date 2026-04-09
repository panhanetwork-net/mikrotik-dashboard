# 2Arah Tech MikroTik Dashboard

Dashboard monitoring real-time berbasis Node.js dan RouterOS REST API untuk perangkat MikroTik. Aplikasi ini menggantikan PRTG dan memberikan tampilan UI yang modern, ringan, dan informatif untuk Network Operations Center (NOC).

## Fitur Utama
- **Real-time Monitoring:** Traffic global, traffic per interface (SFP, LACP, dll.), uptime, CPU beban, dan memori RAM.
- **Dynamic Interface Target:** Polling ke interface spesifik pada Switch CRS-326 (seperti arah BAROS) dapat diset dinamis via `.env` atau komentar di perangkat MikroTik.
- **PPPoE & Connection Tracker:** Melacak jumlah active PPPoE, Hotspot, dan daftar koneksi jaringan aktif yang sedang berlangsung.
- **Firewall & DNS:** Memantau stat firewall dan log dari router, serta tabel Local DNS cache.
- **Telegram Alerting:** Jika VPN putus atau Router offline berturut-turut, sistem mengirim alert ke tim NOC via Telegram dengan delay & toleransi retry.

## Persyaratan
- Node.js v18 atau v20.
- MikroTik RouterOS v7.1++ (wajib support REST API).
- Membuka REST API MikroTik: Buka `IP > Services > www-ssl` atau `api-ssl` beserta sertifikatnya (REST API menggunakan web protokol/API).

## Instalasi

1. Clone repository ini.
2. Pasang dependencies:
   ```bash
   npm install
   ```
3. Copy template file environment dan isi konfigurasinya:
   ```bash
   cp .env.example .env
   ```
4. Jalankan aplikasi:
   ```bash
   npm start
   ```

## Struktur Konfigurasi (`.env`)

Seluruh hardcode kredensial, IP dari berbagai router, dan port API semuanya telah diekstrak ke dalam `.env` untuk keamanan. Aplikasi membaca `MIKROTIK_HOST`, `BRS_HOST`, `SW_HOST`, `SESSION_SECRET`, dll dari environment, sehingga kredensial login **tidak** bisa di-sniff pada sisi frontend browser.

| Variabel | Deskripsi |
|---|---|
| `MIKROTIK_USER` / `_PASS` | Kredensial untuk RouterOS API |
| `MIKROTIK_HOST` / `_API_PORT` | Host & Port API untuk Router Utama |
| `BRS_HOST` / `SW_HOST` | Host IP tujuan untuk router/switch sekunder |
| `PING_TARGET` | Konfigurasi target IP untuk router ping monitor |
| `TELEGRAM_BOT_TOKEN` | Token Telegram bot untuk Alert (opsional) |
| `SESSION_SECRET` | Kunci sesi login Express.js |

## Lisensi
Internal Use Only - 2Arah Tech NOC.
