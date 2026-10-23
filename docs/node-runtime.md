# Project Node.js runtime

Use Node.js **24.22.1 LTS**, including the October 2026 security fixes.
`.nvmrc` and `.node-version` pin the tested release; `package.json` and the
lockfile require the patched 24.x line. The iOS build workflow reads `.nvmrc`.

Production runs in Cloudflare Workers (workerd), not a Node.js server.
Node runs Vite, TypeScript, tests, Wrangler, and Capacitor preparation.
Updating Node alone does not change the deployed Worker or installed iOS app.

## Windows

The project uses a portable runtime so other applications using `D:\Nodejs`
are unaffected. Download `node-v24.22.1-win-x64.zip` from
<https://nodejs.org/dist/v24.22.1/>. Compare its SHA256 with the matching entry
in that directory's `SHASUMS256.txt` before extracting it under `.runtime/`.
The resulting binary must be `.runtime/node-v24.22.1-win-x64/node.exe`.
The runtime directory is ignored by Git.

Run project npm commands through:

```powershell
./scripts/npm-project.ps1 ci
./scripts/npm-project.ps1 run check
./scripts/npm-project.ps1 run test:e2e
./scripts/npm-project.ps1 run build:web
```

The wrapper checks the installed version, puts it first on PATH for child
processes (including Wrangler), and restores PATH afterward. Ordinary `npm`
still uses the machine's runtime. Do not use it for this project's release
validation without first selecting the pinned Node version.

## macOS / Linux / CI

Use `nvm install && nvm use` in the repository, then `npm ci` and the desired
npm command. GitHub Actions uses `node-version-file: '.nvmrc'`.
The existing `config:validate` command references a Windows-local validator;
on other systems use the individual lint, typecheck, test, and build commands,
as the existing macOS CI does.

## Existing desktop preview

The production Windows launcher does not use Node. The developer-only
`PrivateArchive-Local.exe --preview` starts `npx wrangler` from its inherited
PATH. To test that preview with the pinned runtime, launch it from a shell
whose PATH starts with the portable runtime directory. Launching it directly
from Explorer still uses the machine PATH.

When upgrading, update both version files and the engine floor together,
install a checksum-verified runtime, and rerun checks and controlled E2E.
Keep `package-lock.json` dependency versions unchanged for a runtime-only upgrade.
