# Building VC Mix

## Prerequisites

- Windows x64 with OBS Studio 32.1.2 installed.
- Node.js 22.12 or newer and npm.
- Visual Studio 2026 with Desktop development with C++ and CMake available on PATH.

The build downloads OBS's headers and matching Qt SDK from the OBS Project. The Qt SDK checksum is checked against OBS's build manifest, and its version must match the installed Qt runtime. The plugin uses OBS's existing Qt DLLs. Locally compiled decoder bindings are rebuilt with a relative symbol-file reference when needed; generated build folders and debug symbols are excluded from the runtime package.

## Build and test

```powershell
npm ci
npm run check
npm test
npm run build:obs
npm run test:obs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-obs-frontend.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-obs-frontend.ps1 -Theme com.obsproject.Yami.Light
```

The frontend test uses an isolated portable OBS copy, synthetic participants and separate settings. It does not log in to Discord. Actual themed renders are saved under `build/ui-previews`.

Native tests cover settings input, modeless behavior, token masking, display scaling, participant selection, source isolation, disconnect and encrypted settings. TypeScript tests cover decoding, audio boundaries, routing, framing and connection cancellation.

## Package

```powershell
npm run package:obs
npm run build:installer
npm run test:installer
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-obs-package.ps1
npm run check:public
```

Installer builds use NSIS 3.13. The build script downloads its official portable distribution and verifies its SHA-256 checksum. A local `makensis.exe` can also be supplied with `-NsisCompiler`.

Installer tests use the same install/uninstall sections with user-level privileges and an isolated destination under `build`. The shipping installer requests administrator access and registers VC Mix in Windows Installed apps. Tests do not replace the main OBS installation or configuration.

Release artifacts are written to `dist`. Builds are unsigned. The release ZIP contains the complete plugin and source; GitHub releases also provide the installer and SHA-256 checksums.
