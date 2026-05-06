npm install @whiskeysockets/baileys pino qrcode-terminal qrcode jimp qrcode-reader sharp crypto https pm2 -g
npm install @whiskeysockets/baileys pino qrcode qrcode-terminal jimp jsqr sharp

apt remove nodejs -y
apt purge nodejs -y

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs