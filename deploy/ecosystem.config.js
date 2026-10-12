'use strict';

/* TrizEmpire — pm2 process file for a Hostinger VPS (or any Linux host).
 *
 * Hostinger's own Node.js tutorials run apps under pm2 behind nginx, so this
 * file is the pm2 counterpart of deploy/trizempire.service (systemd). Pick
 * ONE process manager — running both means two servers fighting over one port.
 *
 * Install (as the unprivileged app user, from the repo root):
 *   npm install -g pm2
 *   pm2 start deploy/ecosystem.config.js
 *   pm2 save                  # persist the process list across reboots
 *   pm2 startup               # print the root command that enables auto-start
 *
 * Secrets (TRIZ_ADMIN_PASSWORD_HASH etc.) go in trizempire/.env — pm2 does
 * not manage environment files, but the server loads trizempire/.env itself
 * on startup (OS environment always wins). chmod 600 that file.
 *
 * Reverse proxy + TLS: reuse deploy/trizempire-nginx.conf unchanged — it
 * already proxies to the HOST/PORT pinned below and forwards the Host and
 * X-Forwarded-Proto headers the CSRF check depends on. On Hostinger, issue
 * the certificate with certbot (VPS docs) or your panel's SSL tool.
 *
 * Hostinger VPS specifics (2026):
 *   - hPanel → Security → Firewall: the managed firewall defaults to DROP
 *     once a policy group is applied — allow your SSH port, 80 and 443.
 *   - KVM 1 (cheapest plan): 1 vCPU / 4 GB RAM — far more than this
 *     zero-dependency server needs; max_memory_restart below is a safety net.
 *   - cPanel shared hosting cannot run a long-lived Node process; use a VPS
 *     (or Hostinger's managed Node.js Web Apps on eligible plans).
 */

module.exports = {
  apps: [
    {
      name: 'trizempire',
      cwd: '/opt/trizempire/trizempire',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      // Same pins as deploy/trizempire.service and deploy/trizempire-nginx.conf.
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 57004,
        // Local console embed off by default: visitors' browsers cannot
        // reach the operator machine's 127.0.0.1:9119. Set it in
        // trizempire/.env only when the dashboard is genuinely reachable.
        HERMES_PUBLIC_URL: '',
      },
      // Log to files the operator can rotate; pm2's own log module works too:
      //   pm2 install pm2-logrotate
      out_file: '/opt/trizempire/logs/out.log',
      error_file: '/opt/trizempire/logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
