# Building WootonPad from source

No Apple Developer account or code-signing certificate is required. The build scripts handle ad-hoc signing automatically.

## Prerequisites

### macOS
- **Xcode Command Line Tools** — `xcode-select --install`
- **Node.js 20+** — [nodejs.org](https://nodejs.org) or `brew install node`

### Linux
```bash
sudo apt install build-essential python3   # Debian/Ubuntu
# or
sudo dnf install gcc-c++ make python3      # Fedora/RHEL
```
- **Node.js 20+** — [nodejs.org](https://nodejs.org)

### Windows
- **Node.js 20+** — [nodejs.org](https://nodejs.org)
- **Visual Studio Build Tools** — install with "Desktop development with C++" workload, or run:
  ```
  npm install -g windows-build-tools
  ```

---

## Build

```bash
git clone https://github.com/fortael/wootonpad.git
cd wootonpad
npm install
```

Then build for your platform:

```bash
# macOS
npm run build:mac

# Linux
npm run build:linux

# Windows
npm run build:win
```

Output goes to the `dist/` folder.

---

## Install & run

### macOS

The `.dmg` is in `dist/`. Open it, drag **WootonPad.app** to Applications.

On first launch macOS will block the app because it isn't notarized by Apple. To open it anyway:

**Option A** — right-click the app → **Open** → **Open** in the dialog.

**Option B** — remove the quarantine flag, then open normally:
```bash
xattr -cr /Applications/WootonPad.app
open /Applications/WootonPad.app
```

**Option C** — after a blocked launch attempt: **System Settings → Privacy & Security → Open Anyway**.

### Linux

```bash
# AppImage
chmod +x dist/WootonPad-*.AppImage
./dist/WootonPad-*.AppImage

# deb
sudo dpkg -i dist/wootonpad-*.deb
```

### Windows

Run the `.exe` installer from `dist/`. Windows SmartScreen may warn about an unknown publisher — click **More info → Run anyway**.
