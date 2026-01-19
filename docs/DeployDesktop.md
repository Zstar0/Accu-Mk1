# Desktop Deployment Guide

This guide documents the process for compiling Accu-Mk1 into a distributable desktop application.

## Prerequisites

### Required Software

| Software          | Purpose                    | Installation                                                |
| ----------------- | -------------------------- | ----------------------------------------------------------- |
| **Node.js** ≥20   | Frontend build             | [nodejs.org](https://nodejs.org)                            |
| **Rust** (stable) | Tauri backend              | `rustup` via [rust-lang.org](https://rust-lang.org)         |
| **NSIS**          | Windows installer creation | [nsis.sourceforge.io](https://nsis.sourceforge.io/Download) |

### Verify Installation

```powershell
node --version    # Should show v20+
rustc --version   # Should show stable toolchain
```

## Build Commands

### Quick Build (NSIS Installer)

```powershell
npm run tauri build -- --bundles nsis
```

**Output:** `src-tauri/target/release/bundle/nsis/Accu-Mk1_<version>_x64-setup.exe`

### Full Build (All Targets)

```powershell
npm run tauri build
```

Creates installers for all configured platforms (MSI, NSIS, etc.)

## Troubleshooting

### Error: "Access is denied (os error 5)"

**Cause:** The `.exe` file is locked because the app is still running.

**Fix:**

```powershell
Stop-Process -Name "tauri-app" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "Accu-Mk1" -Force -ErrorAction SilentlyContinue
# Then retry build
```

### Error: "missing field `pubkey`"

**Cause:** Tauri updater plugin requires pubkey even when disabled.

**Fix:** In `src-tauri/tauri.conf.json`, ensure updater config has empty pubkey:

```json
"plugins": {
  "updater": {
    "active": false,
    "endpoints": [],
    "dialog": false,
    "pubkey": ""
  }
}
```

### App Shows "Backend Offline" But Backend Works

**Cause:** CORS not configured for Tauri v2 origin.

**Fix:** Add these origins to `backend/main.py` CORS config:

```python
"https://tauri.localhost",    # Tauri v2
"http://tauri.localhost",
"tauri://localhost",          # Tauri v1
```

### TypeScript Errors During Build

**Fix:** Run typecheck first and fix errors:

```powershell
npm run typecheck
```

Common issues:

- Unused imports (remove them)
- `unknown` type in JSX expressions (use explicit type assertions)

### Clean Rebuild

If build artifacts are corrupted or stale:

```powershell
cd src-tauri
cargo clean --release
cd ..
npm run tauri build -- --bundles nsis
```

## Version Management

Update version in **both** files before building:

1. `package.json` - Line 4: `"version": "x.x.x"`
2. `src-tauri/tauri.conf.json` - Line 4: `"version": "x.x.x"`

Also update version footer in `src/components/layout/MainWindow.tsx` if hardcoded.

## Configuration Reference

### tauri.conf.json Key Settings

| Path               | Purpose                               |
| ------------------ | ------------------------------------- |
| `productName`      | App name in installer                 |
| `version`          | Displayed version                     |
| `bundle.publisher` | Shown in Windows                      |
| `bundle.icon`      | App icons (ICO, ICNS, PNG)            |
| `app.security.csp` | Content Security Policy for API calls |
| `plugins.updater`  | Auto-update configuration             |

### CSP for Backend Access

The CSP must include backend URL:

```
connect-src 'self' tauri: ipc: http://127.0.0.1:8009
```

## Deployment Notes

### Backend Requirement

The installed app requires the Python backend running:

```powershell
cd backend
uvicorn main:app --port 8009
```

Without the backend, the app will show "Backend offline" and features won't work.

### Future: Bundling Backend as Sidecar

To make the app fully self-contained, bundle the Python backend using PyInstaller and configure as a Tauri sidecar. This is not yet implemented.
