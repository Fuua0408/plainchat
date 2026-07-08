'use strict';

// public/icons/*.svg から PWA 用 PNG を生成する。再生成が必要になったときに
// `node scripts/generate-icons.js` で実行する(通常は一度きりの手順)。
const path = require('path');
const sharp = require('sharp');

const iconsDir = path.join(__dirname, '..', 'public', 'icons');

const targets = [
  { src: 'icon.svg', out: 'icon-192.png', size: 192 },
  { src: 'icon.svg', out: 'icon-512.png', size: 512 },
  { src: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512 },
  { src: 'icon.svg', out: 'apple-touch-icon.png', size: 180 },
];

async function main() {
  for (const { src, out, size } of targets) {
    const srcPath = path.join(iconsDir, src);
    const outPath = path.join(iconsDir, out);
    await sharp(srcPath, { density: 384 })
      .resize(size, size)
      .png()
      .toFile(outPath);
    console.log(`generated ${out} (${size}x${size}) from ${src}`);
  }
}

main().catch((e) => {
  console.error('icon generation failed:', e);
  process.exit(1);
});
