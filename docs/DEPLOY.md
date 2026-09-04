# Deploying the fixed-domain relay

This is the **optional** piece that gives you one stable public URL
(`https://ai.example.com/v1`) that automatically follows the drifting CNB
workspace subdomain. It runs on any small VPS with nginx.

If you skip it, just use the raw `https://<subdomain>-9001.cnb.run/v1` printed in
the build log — but that URL changes every workspace restart.

Replace every placeholder below with your own values:
`ai.example.com` (your domain), `9001` (workspace port), paths as you prefer.

## Pieces

1. **`cnb-register.py`** (from `deploy/`) — a tiny HTTP service on
   `127.0.0.1:9003`. It receives the workspace's `PROXY_URI` and rewrites an
   nginx `map` so the fixed domain points at the current subdomain.
2. **nginx** — terminates TLS for your domain, proxies `/` to the workspace via
   the map variable, and exposes `/ops/register` to the local service.
3. **systemd** — keeps `cnb-register.py` running.

## Domain, DNS and TLS

1. Point an `A`/`AAAA` record for `ai.example.com` at the VPS. If you front it
   with a CDN (e.g. Cloudflare proxying on), use an Origin certificate — below.
2. TLS certificate, either of:
   - **Cloudflare Origin certificate** (recommended when proxying through
     Cloudflare): create it in the Cloudflare dashboard, install the two PEM
     files under `/etc/nginx/ssl/`, set SSL mode to *Full (strict)*.
   - **Let's Encrypt**: `sudo apt install certbot python3-certbot-nginx &&
     sudo certbot --nginx -d ai.example.com`, then drop the manual
     `ssl_certificate` lines (certbot manages them).

## 1. The register service

Install the script and its token file:

```bash
sudo install -m 755 deploy/cnb-register.py /usr/local/bin/cnb-register.py
sudo mkdir -p /root/.cnb
# REG_TOKEN must match what the workspace sends (same value in your secrets repo)
echo 'REG_TOKEN=your-long-random-shared-secret' | sudo tee /root/.cnb/register.env
sudo chmod 600 /root/.cnb/register.env
```

systemd unit `/etc/systemd/system/cnb-register.service`:

```ini
[Unit]
Description=CNB AI proxy self-registration endpoint
After=network.target

[Service]
ExecStart=/usr/bin/python3 /usr/local/bin/cnb-register.py
Restart=always
# Optional overrides (defaults shown):
#Environment=UPSTREAM_CONF=/etc/nginx/conf.d/cnb-ai-upstream.conf
#Environment=UPSTREAM_PORT=9001
#Environment=REGISTER_ENV_FILE=/root/.cnb/register.env

[Install]
WantedBy=multi-user.target
```

The service runs as root because it writes nginx config and runs
`nginx -t` / `systemctl reload nginx`. Keep it bound to `127.0.0.1` only (it is);
nginx is the sole public entry.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cnb-register
```

## 2. nginx

The upstream target lives in its own file so the register service can rewrite it
atomically. Seed it once (any value; it gets replaced on first registration —
and `cnb-register.py` also creates this file on demand if it's ever missing):

`/etc/nginx/conf.d/cnb-ai-upstream.conf`:

```nginx
map $request_uri $cnb_ai_upstream { default placeholder-9001.cnb.run:443; }
```

> Seed this file **before** enabling the vhost below: the vhost references
> `$cnb_ai_upstream`, and `nginx -t` fails with "unknown variable" while the
> map file is absent.

Virtual host `/etc/nginx/sites-available/ai.example.com` (adjust TLS + domain):

```nginx
server {
    listen 80;
    server_name ai.example.com;
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name ai.example.com;

    # Must cover the proxy's own body cap (4 MiB); nginx defaults to 1 MiB,
    # which would reject long-context requests here with a bare nginx 413
    # before they ever reach the proxy.
    client_max_body_size 8m;

    ssl_certificate     /etc/nginx/ssl/your.crt;
    ssl_certificate_key /etc/nginx/ssl/your.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    # Self-registration endpoint (workspace -> relay). Local only.
    # Optional hardening: rate-limit token guessing with
    #   limit_req_zone $binary_remote_addr zone=reg:10m rate=30r/m;  (http level)
    #   limit_req zone=reg burst=10 nodelay;                          (here)
    location = /ops/register {
        proxy_pass http://127.0.0.1:9003/register;
    }

    # Everything else -> current workspace port-proxy (via the map variable).
    location / {
        proxy_pass https://$cnb_ai_upstream;   # variable form: https + correct SNI
        proxy_http_version 1.1;
        proxy_ssl_server_name on;
        proxy_ssl_name $cnb_ai_upstream;
        proxy_set_header Host $cnb_ai_upstream;
        proxy_set_header Connection '';
        proxy_buffering off;                    # stream SSE without buffering
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 15s;
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/ai.example.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> If you front this with a CDN (e.g. Cloudflare), add the CDN's real-IP ranges
> with `set_real_ip_from` + `real_ip_header CF-Connecting-IP` so logs and rate
> limits see the true client IP.

## 3. Wire the workspace to the relay

In your CNB repo's `.cnb.yml` (or the secrets repo it imports), set:

```
REGISTER_URL=https://ai.example.com/ops/register
REG_TOKEN=your-long-random-shared-secret   # same value as /root/.cnb/register.env
```

On the next workspace boot, `start.sh` self-registers and the relay repoints the
map. Verify:

```bash
curl https://ai.example.com/health
curl https://ai.example.com/v1/models -H "Authorization: Bearer $PROXY_KEY"
```

## How the switch stays safe

`cnb-register.py` validates the reported URI against
`^https://([a-z0-9]+)-\{\{port\}\}\.cnb\.run$`, backs up the current map to
`.regbak`, writes the new map, runs `nginx -t`, and only then reloads — rolling
back to the previous config if either the test or the reload fails. So a bad
registration never takes the fixed domain down.
