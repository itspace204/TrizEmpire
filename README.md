# TrizEmpire

**TrizEmpire** is an original project by the repository owner. Reference images were used for visual direction; the implementation, project structure, and code are the owner's work. This repository is being organized for maintainability, safer local operation, and clear contributor setup.

The currently inspected application is **TrizEmpire**, a static Node.js operator interface designed to run alongside a Hermes managing backend on the same machine.

> **Security notice:** TrizEmpire is not an authenticated multi-user web application. Keep it bound to loopback. Do not expose it to the public internet or a shared network until authentication, authorization, and a secured remote backend connection have been designed and tested.

## Repository layout

- `nexora/index.html` — operator interface (the current HTML filename is retained for compatibility).
- `nexora/server.js` — dependency-free Node.js static file server, defaulting to `127.0.0.1:57004`.
- `nexora/package.json` — scripts and Node.js engine requirement.
- `.github/workflows/nexora-checks.yml` — automated syntax, test, and secret-scanning checks.
- `SECURITY.md` — security boundaries and vulnerability reporting.

## Requirements

- Node.js 20 or later; Node.js 24 LTS is recommended.
- A Hermes backend running locally on port `9119` for live status and console integration. The UI can load without Hermes, but those features will show the backend as offline.

## Run locally

From the repository root:

```sh
cd nexora
npm start
```

Open [http://127.0.0.1:57004](http://127.0.0.1:57004).

No `npm install` is required for this app's static server because it uses only Node.js built-in modules.

## Checks and tests

From `nexora/`:

```sh
npm run check
npm test
```

These use Node's built-in syntax checker and test runner.

## Configuration

- `HOST`: defaults to `127.0.0.1`. The server refuses a non-loopback host unless `ALLOW_REMOTE_HOST=true` is explicitly set.
- `PORT`: defaults to `57004`; must be an integer from 1 through 65535.

**Do not set `ALLOW_REMOTE_HOST=true` on a public or untrusted network.** This switch does not add authentication.

## Secrets and security

- Never commit API keys, passwords, session tokens, private keys, or production database credentials.
- Keep secrets in ignored environment files or an approved secret manager; commit placeholders only.
- If a secret was committed, revoke or rotate it. Deleting it from the latest version does not remove it from Git history.
- The browser UI points to `http://127.0.0.1:9119`. For visitors, that address means their own computer, not the operator's server. Remote deployment needs an authenticated API/proxy rather than a hardcoded localhost address.
- Dashboard values must only be presented as live telemetry when they are backed by real measurements.

## License

The project owner has stated that the implementation is original and reference images were used for visual direction. Before adding a public license, ensure the images, fonts, icons, and any other third-party assets have compatible terms. The repository remains `UNLICENSED` until the owner selects and approves a license.
