const { execSync, spawn } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');
const os = require('os');

const pkg = require('../package.json');
const platform = os.platform();

const targets = {
  win32: {
    buildCmd: `npm run build:win:portable`,
    output: path.join('dist', 'win-unpacked', `${pkg.build.productName}.exe`),
  },
  darwin: {
    buildCmd: `npm run build:mac`,
    output: path.join('dist', `mac-${os.arch() === 'arm64' ? 'arm64' : ''}`, `${pkg.build.productName}.app`),
  },
  linux: {
    buildCmd: `npm run build:linux`,
    output: path.join('dist', `${pkg.build.productName}-${pkg.version}.AppImage`),
  },
};

const target = targets[platform];
if (!target) {
  console.error(`Unsupported platform: ${platform}`);
  process.exit(1);
}

console.log(`Building ${pkg.build.productName} ${pkg.version} for ${platform}...`);
execSync(target.buildCmd, { stdio: 'inherit', cwd: path.join(__dirname, '..') });

const resolved = path.resolve(__dirname, '..', target.output);
if (!existsSync(resolved)) {
  // Try glob-like fallback for versioned filenames
  const dir = path.dirname(resolved);
  const base = path.basename(resolved, path.extname(resolved));
  if (existsSync(dir)) {
    const fs = require('fs');
    const match = fs.readdirSync(dir).find((f) => f.startsWith(base));
    if (match) {
      const fallback = path.join(dir, match);
      console.log(`Opening ${fallback}...`);
      spawn(fallback, [], { detached: true, stdio: 'ignore' }).unref();
      process.exit(0);
    }
  }
  console.error(`Build output not found at ${resolved}`);
  process.exit(1);
}

console.log(`Opening ${resolved}...`);
if (platform === 'darwin') {
  spawn('open', [resolved], { stdio: 'ignore' }).unref();
} else {
  spawn(resolved, [], { detached: true, stdio: 'ignore' }).unref();
}
