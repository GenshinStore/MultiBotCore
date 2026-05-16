sudo apt update && sudo apt upgrade -y
sudo apt install curl -y
sudo apt install -y nodejs
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g npm@latest
npm install @whiskeysockets/baileys pino qrcode qrcode-terminal jimp jsqr sharp
npm install -g pm2

apt remove nodejs -y
apt purge nodejs -y

pm2 start core.js --name core


