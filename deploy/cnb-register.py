#!/usr/bin/env python3
"""Self-registration endpoint for the CNB AI proxy relay.

On workspace boot, start.sh POSTs this workspace's CNB_VSCODE_PROXY_URI here.
This service rewrites the nginx upstream map to point the fixed domain at the
current workspace subdomain, validates the config, and reloads nginx.

Listens on 127.0.0.1:9003; expose it via `nginx location = /ops/register`.
Auth: X-Reg-Token, read from REGISTER_ENV_FILE (default /root/.cnb/register.env),
which must contain a line `REG_TOKEN=...` matching the token start.sh sends.

Deployment details (systemd unit, nginx vhost) are in docs/DEPLOY.md.
"""
import json
import hmac
import os
import re
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer

# nginx map file this service owns; see docs/DEPLOY.md for the vhost that reads it.
CONF = os.environ.get('UPSTREAM_CONF', '/etc/nginx/conf.d/cnb-ai-upstream.conf')
ENV_FILE = os.environ.get('REGISTER_ENV_FILE', '/root/.cnb/register.env')
LISTEN_PORT = int(os.environ.get('REGISTER_PORT', '9003'))
# Port the workspace port-proxy exposes; CNB emits it as the {{port}} template token.
UPSTREAM_PORT = os.environ.get('UPSTREAM_PORT', '9001')

TOKEN = ''
for line in open(ENV_FILE):
    if line.startswith('REG_TOKEN='):
        TOKEN = line.split('=', 1)[1].strip().strip('"')

# CNB_VSCODE_PROXY_URI looks like https://<subdomain>-{{port}}.cnb.run
URI_RE = re.compile(r'^https://([a-z0-9]+)-\{\{port\}\}\.cnb\.run$')


def switch(sub):
    new = "map $request_uri $cnb_ai_upstream { default %s-%s.cnb.run:443; }\n" % (sub, UPSTREAM_PORT)
    cur = open(CONF).read()
    if cur == new:
        return {'ok': True, 'switched': False, 'sub': sub}
    open(CONF + '.regbak', 'w').write(cur)
    open(CONF, 'w').write(new)
    t = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
    if t.returncode != 0:
        open(CONF, 'w').write(cur)
        return {'ok': False, 'error': 'nginx -t failed, rolled back', 'detail': t.stderr[-300:]}
    r = subprocess.run(['systemctl', 'reload', 'nginx'], capture_output=True, text=True)
    if r.returncode != 0:
        open(CONF, 'w').write(cur)
        return {'ok': False, 'error': 'reload failed, rolled back', 'detail': r.stderr[-300:]}
    return {'ok': True, 'switched': True, 'sub': sub}


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if not hmac.compare_digest(self.headers.get('X-Reg-Token', ''), TOKEN):
            self.send_response(403); self.end_headers(); return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"service":"cnb-register","ok":true}')

    def do_POST(self):
        if self.path != '/register':
            self.send_response(404); self.end_headers(); return
        if not hmac.compare_digest(self.headers.get('X-Reg-Token', ''), TOKEN):
            self.send_response(403); self.end_headers(); self.wfile.write(b'{"ok":false,"error":"bad token"}'); return
        try:
            length = int(self.headers.get('Content-Length', '0') or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 4096:
            self.send_response(400); self.end_headers(); self.wfile.write(b'{"ok":false,"error":"bad length"}'); return
        try:
            uri = str(json.loads(self.rfile.read(length)).get('uri', ''))
        except Exception:
            self.send_response(400); self.end_headers(); self.wfile.write(b'{"ok":false,"error":"bad json"}'); return
        m = URI_RE.match(uri)
        if not m:
            self.send_response(400); self.end_headers(); self.wfile.write(b'{"ok":false,"error":"uri not match PROXY_URI pattern"}'); return
        result = switch(m.group(1))
        print('register:', json.dumps(result, ensure_ascii=False), flush=True)
        self.send_response(200 if result.get('ok') else 500)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    HTTPServer(('127.0.0.1', LISTEN_PORT), H).serve_forever()
