# Security policy

## Deployment boundary

NEXORA is a local operator interface and does not implement user authentication or authorization. Keep the server on loopback. Do not expose it to the internet or an untrusted LAN. Setting `ALLOW_REMOTE_HOST=true` does not secure the application.

The browser UI contacts a Hermes endpoint at `127.0.0.1:9119`; this is the visitor's own loopback interface when the UI is opened in a browser. Do not treat it as a secure remote API.

## Secrets

- Do not commit credentials, access tokens, private keys, production database URLs, or real `.env` files.
- Use environment variables or a secret manager for runtime credentials.
- Revoke and rotate any credential suspected of being exposed.
- A secret removed from the current tree may remain in commit history; review history and follow GitHub's sensitive-data removal guidance if needed.

## Reporting a vulnerability

Please do not publish exploit details or credentials in a public issue. Use GitHub's private vulnerability reporting feature for this repository if it is enabled. If it is unavailable, contact the repository owner privately before sharing technical details.

## Current limitations

The static server is not a replacement for a security review of the Hermes service. Authentication, authorization, rate limiting, remote transport security, audit logging, and end-to-end integration tests must be designed before remote exposure.
