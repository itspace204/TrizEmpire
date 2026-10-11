# TrizEmpire

TrizEmpire is a collection of local-first operator tools and agent-related resources. The currently inspected application is **NEXORA**, a static Node.js UI intended to run alongside a Hermes managing backend on the same machine.

> **Security notice:** NEXORA is not an authenticated multi-user web application. Keep it bound to loopback. Do not expose it to the public internet or a shared network until authentication, authorization, CSRF protections where applicable, and a secured remote backend connection have been designed and tested.

## Repository layout

- `nexora/index.html` — NEXORA single-page operator interface.
- `nexora/server.js` — dependency-free Node.js static file server, defaulting to `127.0.0.1:57004`.
- `nexora/package.json` — scripts and Node.js engine requirement for NEXORA.
- `.gitignore` — local files and secret-bearing environment files to keep out of Git.

This is a deliberately minimal Node.js app; it does not currently use a frontend build system, package dependencies, or a database in the inspected NEXORA directory. Other repository content may have different requirements.

## Requirements

- Node.js 20 or later (Node.js 24 LTS is recommended).
- A Hermes backend running locally on port `9119` for live status and console integration. The UI can load without Hermes, but those features will show the backend as offline.

## Run locally

From the repository root:

```sh
cd nexora
npm start
```

Open [http://127.0.0.1:57004](http://127.0.0.1:57004).

No `npm install` is required for NEXORA because its server uses Node.js built-in modules only.

## Checks and tests

From `nexora/`:

```sh
npm run check
npm test
```

The tests use Node's built-in test runner and do not require a third-party test framework. CI runs these checks on supported Node.js versions.

## Configuration

- `HOST`: defaults to `127.0.0.1`. The server refuses a non-loopback host unless `ALLOW_REMOTE_HOST=true` is explicitly set.
- `PORT`: defaults to `57004`, and must be an integer from 1 through 65535.

**Do not set `ALLOW_REMOTE_HOST=true` on a public or untrusted network.** That switch only overrides the local binding guard; it does not add authentication or make remote deployment safe.

The current browser UI points at `http://127.0.0.1:9119`. A public website would make that address refer to each visitor's own computer, not the developer's Hermes server. Remote access needs a deliberately designed authenticated API/proxy, not a hardcoded localhost URL.

## Secrets and security

- Never commit API keys, passwords, session tokens, private keys, or production database credentials.
- Store local secrets in ignored environment files or an approved secret manager; provide placeholders only in examples.
- If a secret was ever committed, revoke or rotate it. Deleting it from the latest commit does not remove it from Git history.
- Keep this UI local-only until the security model is reviewed.
- See [SECURITY.md](SECURITY.md) for reporting and handling vulnerabilities.

## Tests versus production readiness

Passing the checks confirms syntax and the tested local HTTP behavior only. It does not certify the Hermes backend, agent isolation, remote deployment, operational data accuracy, or the security of external integrations. Dashboard values that are currently illustrative should not be treated as production telemetry.

## License

The NEXORA package currently declares `UNLICENSED`, and no root license has been verified. Until the project owner confirms the licensing rights for all bundled code and tutorial-derived content, assume reuse is **not granted**. A root license should be added only after that review.
