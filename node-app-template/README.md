# Node app template

Every app on this machine starts from this folder so it is Node.js compatible by default.

## Machine setup (done once — already complete)

- Node.js **v24.21.0 LTS** + npm 11.19.0 installed at
  `C:\Users\USER\AppData\Local\Programs\nodejs`
- That folder is on the **user PATH**, so any new terminal, script or app can run
  `node` / `npm` directly. (Terminals opened before the install need a restart to see it.)

## Starting a new app

1. Copy this folder, rename it to the app name.
2. Edit `package.json`: set `name` (and version/description).
3. Put your static files (`index.html`, etc.) next to `server.js`.
4. Run:

   ```
   npm start          # or: node server.js
   ```

   The default port is **3000**; override per app with `PORT=57005 npm start`
   (PowerShell: `$env:PORT=57005; npm start`).

## Conventions

- **Zero dependencies by default.** `server.js` uses only Node built-ins, so there
  is nothing to install and no lockfile to maintain. Add real npm packages only when
  the app genuinely needs them.
- **`npm start` must always work.** Every app exposes a `start` script so it can be
  launched the same way everywhere.
- **Localhost bind.** Servers bind `127.0.0.1` unless there is a stated reason not to.
- Real example in use: `../trizempire/` serves the TrizEmpire operator UI on port 57004 with
  this same server file.
