sudo apt update && sudo apt upgrade -y
sudo apt install curl -y
sudo apt install -y nodejs
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -

apt install -y nodejs
npm install -g npm@latest
npm install @whiskeysockets/baileys pino qrcode qrcode-terminal jimp jsqr sharp

npm install -g pm2

apt remove nodejs -y
apt purge nodejs -y

pm2 start core.js --name core

https://github.com/GenshinStore/MultiBotCore.git

sudo env PATH=$PATH:/usr/bin /usr/local/lib/node_modules/pm2/bin/pm2 startup systemd -u ubuntu --hp /home/ubuntu

Ikuti langkah-langkah berikut untuk setup environment dan menjalankan bot di VPS:

### 1. Update Sistem & Instal Library Grafik

Modul pengolah gambar (`sharp`) memerlukan dependency sistem untuk melakukan kompilasi.

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential gcc g++ make libvips-dev curl git
2. Instal Node.js (Versi 20 LTS)
Bash
# Setup repository Node.js v20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -

# Instal Node.js
sudo apt install -y nodejs
3. Setup Direktori Proyek & Dependency
Masuk ke direktori proyek, pastikan file core.js sudah berada di dalam folder ini, lalu instal package yang dibutuhkan:

Bash
mkdir -p /root/MultiBotCore
cd /root/MultiBotCore

# Inisialisasi package.json dan instal modul
npm init -y
npm install @whiskeysockets/baileys pino qrcode qrcode-terminal jsqr sharp
4. Jalankan Menggunakan PM2 (Process Manager)
Agar bot tetap berjalan di background meskipun terminal SSH ditutup:

Bash
# Instal PM2 secara global
sudo npm install -y pm2 -g

# Jalankan bot
pm2 start core.js --name "core"

# Simpan proses agar otomatis hidup saat VPS restart
pm2 startup
pm2 save
```
