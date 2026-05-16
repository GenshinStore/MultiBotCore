sudo apt update && sudo apt upgrade -y
sudo apt install curl -y
sudo apt install -y nodejs
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm install @whiskeysockets/baileys pino qrcode qrcode-terminal jimp jsqr sharp

apt remove nodejs -y
apt purge nodejs -y

pm2 start core.js -i max


