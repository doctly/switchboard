#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const png2icons = require('png2icons');
const { loadImage, createCanvas } = require('@napi-rs/canvas');

const OUTPUT_DIR = path.join(__dirname, '..', 'build');
const pngPath = path.join(OUTPUT_DIR, 'icon.png');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// If icon.png already exists, use it; otherwise generate a placeholder
if (!fs.existsSync(pngPath)) {
  const SIZE = 1024;
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  gradient.addColorStop(0, '#6B21A8');
  gradient.addColorStop(0.5, '#7C3AED');
  gradient.addColorStop(1, '#0D9488');

  const radius = SIZE * 0.22;
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(SIZE - radius, 0);
  ctx.quadraticCurveTo(SIZE, 0, SIZE, radius);
  ctx.lineTo(SIZE, SIZE - radius);
  ctx.quadraticCurveTo(SIZE, SIZE, SIZE - radius, SIZE);
  ctx.lineTo(radius, SIZE);
  ctx.quadraticCurveTo(0, SIZE, 0, SIZE - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold ${SIZE * 0.45}px -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('SB', SIZE / 2, SIZE / 2 + SIZE * 0.02);

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = `${SIZE * 0.07}px -apple-system, "Segoe UI", sans-serif`;
  ctx.fillText('Switchboard', SIZE / 2, SIZE * 0.85);

  fs.writeFileSync(pngPath, canvas.toBuffer('image/png'));
  console.log(`Generated placeholder ${pngPath}`);
} else {
  console.log(`Using existing ${pngPath}`);
}

// macOS: create padded icon (macOS expects ~80% inset with transparent border)
// then use iconutil for perfect transparency support
if (process.platform === 'darwin') {
  const paddedPath = path.join(OUTPUT_DIR, 'icon-padded.png');
  // Create a 1024x1024 transparent canvas with the icon at 80% centered
  const PADDED_SIZE = 1024;
  const INSET = Math.round(PADDED_SIZE * 0.1); // 10% padding on each side = 80% content
  const INNER = PADDED_SIZE - INSET * 2;
  execSync(`sips -z ${INNER} ${INNER} "${pngPath}" --out "${paddedPath}"`, { stdio: 'ignore' });
  // Use sips to pad: create blank canvas then composite
  // sips can't composite easily, so use a Python one-liner with CoreImage
  execSync(`python3 -c "
from PIL import Image
bg = Image.new('RGBA', (${PADDED_SIZE}, ${PADDED_SIZE}), (0, 0, 0, 0))
fg = Image.open('${paddedPath}').convert('RGBA')
bg.paste(fg, (${INSET}, ${INSET}), fg)
bg.save('${paddedPath}')
"`, { stdio: 'inherit' });

  const iconsetDir = path.join(OUTPUT_DIR, 'icon.iconset');
  fs.mkdirSync(iconsetDir, { recursive: true });

  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const size of sizes) {
    // Standard resolution
    execSync(`sips -z ${size} ${size} "${paddedPath}" --out "${path.join(iconsetDir, `icon_${size}x${size}.png`)}"`, { stdio: 'ignore' });
    // @2x (half the name, double the pixels)
    if (size <= 512) {
      execSync(`sips -z ${size * 2} ${size * 2} "${paddedPath}" --out "${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}"`, { stdio: 'ignore' });
    }
  }
  // Rename 1024 to 512@2x (required by iconutil)
  const icon1024 = path.join(iconsetDir, 'icon_1024x1024.png');
  if (fs.existsSync(icon1024)) fs.unlinkSync(icon1024);

  const icnsPath = path.join(OUTPUT_DIR, 'icon.icns');
  execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`, { stdio: 'ignore' });
  // Clean up
  fs.rmSync(iconsetDir, { recursive: true });
  fs.unlinkSync(paddedPath);
  console.log(`Created ${icnsPath} (with macOS padding)`);
} else {
  // Non-macOS fallback: use png2icons
  const pngBuffer = fs.readFileSync(pngPath);
  const icnsBuffer = png2icons.createICNS(pngBuffer, png2icons.BICUBIC2, 0);
  if (icnsBuffer) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'icon.icns'), icnsBuffer);
    console.log(`Created icon.icns (${icnsBuffer.length} bytes)`);
  }
}

// ICO (Windows) — png2icons on all platforms
const pngBuffer = fs.readFileSync(pngPath);
const icoBuffer = png2icons.createICO(pngBuffer, png2icons.BICUBIC2, 0, true);
if (icoBuffer) {
  const icoPath = path.join(OUTPUT_DIR, 'icon.ico');
  fs.writeFileSync(icoPath, icoBuffer);
  console.log(`Created ${icoPath} (${icoBuffer.length} bytes)`);
}

// Linux: hicolor-sized PNGs for /usr/share/icons/hicolor/<size>x<size>/apps/
// electron-builder picks these up when linux.icon points at the directory.
(async () => {
  const linuxDir = path.join(OUTPUT_DIR, 'icons');
  fs.mkdirSync(linuxDir, { recursive: true });
  const img = await loadImage(pngPath);
  for (const size of [16, 32, 48, 64, 128, 256, 512]) {
    const c = createCanvas(size, size);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, size, size);
    fs.writeFileSync(path.join(linuxDir, `${size}x${size}.png`), c.toBuffer('image/png'));
  }
  console.log(`Created ${linuxDir} (Linux hicolor sizes)`);
  console.log('Icon generation complete.');
})();
