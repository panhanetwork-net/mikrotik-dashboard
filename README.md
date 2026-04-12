<h1 align="center">MikroTik & NOC Dashboard</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-v18.x+-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Express.js-Backend-000000?style=for-the-badge&logo=express&logoColor=white" alt="Express">
  <img src="https://img.shields.io/badge/MikroTik-RouterOS_API-1E2B3E?style=for-the-badge" alt="MikroTik">
  <img src="https://img.shields.io/badge/SNMP-v2c-0078D4?style=for-the-badge" alt="SNMP">
  <img src="https://img.shields.io/badge/PM2-Deployment-2B037A?style=for-the-badge&logo=pm2&logoColor=white" alt="PM2">
</p>

Dashboard monitoring dan manajemen jaringan berbasis web yang terintegrasi secara *real-time* dengan MikroTik RouterOS melalui REST API dan memonitor berbagai perangkat eksternal (Switch, OLT, Router) menggunakan protokol SNMP. Menyediakan antarmuka visual dinamis untuk memantau koneksi aktif, bandwidth PPPoE, laporan *firewall log*, dan status perangkat secara instan dengan dukungan alert Telegram.

## Requirements
- **Node.js** (v18.x atau versi terbaru yang stabil disarankan)
- **NPM** (Node Package Manager)
- Akses ke Router **MikroTik** (RouterOS) dengan fitur API yang telah diaktifkan (`IP > Services > api`)
- **PM2** (Opsional, sangat disarankan untuk menjalankan aplikasi di server *production*)
- Perangkat jaringan yang mendukung SNMP v2c (jika ingin menggunakan fitur SNMP)

## Installation

1. Buka terminal dan clone/unduh repositori ini ke dalam server atau komputer Anda.
2. Masuk ke dalam direktori project:
   ```bash
   cd mikrotik-dashboard
   ```
3. Install semua *dependencies* (paket yang dibutuhkan) menggunakan NPM:
   ```bash
   npm install
   ```
4. Ubah nama atau salin file contoh *environment* Anda menjadi `.env`:
   ```bash
   cp .env.example .env
   ```
   *(Jika file .env belum ada, jalankan aplikasi satu kali atau edit dari halaman Settings)*
5. Jalankan aplikasi di environment *development*:
   ```bash
   node server.js
   ```
6. **Untuk Production (Menggunakan PM2):**
   ```bash
   pm2 start server.js --name "mikrotik-dashboard" --update-env
   ```
7. Buka browser dan akses dashboard melalui alamat `http://<IP_SERVER>:<PORT>` (Port default adalah 3000). Masukkan konfigurasi Anda via UI *Settings*.

### Troubleshooting
*Apakah Anda memiliki panduan langkah-langkah spesifik (seperti cara menyalakan router, mengatasi izin API, atau error PM2) yang ingin ditambahkan di sini? Silakan beritahu saya agar struktur perbaikannya dapat ditambahkan.*

<p align="right">
  <b>Author:</b> misuminitt
</p>
