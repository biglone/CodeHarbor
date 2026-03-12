# Standalone Admin Deployment (With Cloudflare Tunnel Option)

This guide documents how to run `codeharbor admin serve` as an independent service and optionally expose it on a public domain.

## 1) Deployment Model

`admin serve` can run independently from `codeharbor start`.

- Service A: `codeharbor start` (Matrix -> Codex gateway)
- Service B: `codeharbor admin serve` (Admin UI + Admin API)

They can be started/stopped independently, while sharing the same `.env` and SQLite state path.

## 2) Baseline Security

For any non-local access, set:

- `ADMIN_BIND_HOST=127.0.0.1`
- `ADMIN_PORT=8787`
- `ADMIN_TOKEN=<a-long-random-token>` or `ADMIN_TOKENS_JSON=[...]`
- `ADMIN_ALLOWED_ORIGINS=https://admin.example.com` (when browser UI is served from a separate origin)

Why this baseline:

- Local bind prevents accidental direct internet exposure.
- Public access is delegated to the gateway/tunnel layer.
- Token protects `/api/admin/*` operations (`ADMIN_TOKENS_JSON` supports viewer/admin RBAC).
- Origin allowlist limits browser-based cross-origin access to trusted admin domains.

## 3) Start Admin Service Only

```bash
codeharbor admin serve
```

Override bind host/port if needed:

```bash
codeharbor admin serve --host 127.0.0.1 --port 8787
```

Security guardrail:

- If host is non-loopback and both `ADMIN_TOKEN` and `ADMIN_TOKENS_JSON` are empty, startup is rejected by default.
- You can bypass with `--allow-insecure-no-token` (not recommended).

## 4) systemd (Recommended for Servers)

Example unit (`/etc/systemd/system/codeharbor-admin.service`):

```ini
[Unit]
Description=CodeHarbor Admin Server
After=network.target

[Service]
Type=simple
User=codeharbor
WorkingDirectory=/opt/codeharbor
EnvironmentFile=/opt/codeharbor/.env
ExecStart=/usr/bin/env node /opt/codeharbor/dist/cli.js admin serve
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codeharbor-admin.service
sudo systemctl status codeharbor-admin.service
```

## 5) Expose Admin Through Cloudflare Tunnel

Prerequisites:

1. Domain is managed in Cloudflare.
2. `cloudflared` is installed on the target machine.
3. `cloudflared tunnel login` completed.

Example workflow:

```bash
# 1) create tunnel
cloudflared tunnel create codeharbor-admin

# 2) route domain to tunnel
cloudflared tunnel route dns codeharbor-admin admin.example.com
```

Create config file `~/.cloudflared/codeharbor-admin.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/<user>/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: admin.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Run tunnel:

```bash
cloudflared tunnel --config ~/.cloudflared/codeharbor-admin.yml run
```

## 6) Verification

Local service:

```bash
curl -I http://127.0.0.1:8787/
```

Public domain:

```bash
curl -I https://admin.example.com/
```

Admin API auth check:

```bash
curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
  https://admin.example.com/api/admin/config/global
```

## 7) Operational Notes

1. In tunnel mode, keep backend service on loopback (`127.0.0.1`) whenever possible.
2. Do not treat tunnel as authentication. Keep `ADMIN_TOKEN` enabled.
3. If exposing to broader audience, add additional gateway controls (WAF/Access rules).
4. For config changes that are restart-scoped, restart related service after save.

Token rotation helper (from repository root):

```bash
./scripts/rotate-admin-token.sh --target rbac --role admin --actor ops-admin
./scripts/rotate-admin-token.sh --target rbac --role viewer --actor ops-audit
```
