#!/usr/bin/env python3
"""Temporal parser microservice — dateparser-based multilingual date extraction."""

import json
import os
import signal
import socket
import sys
import tempfile
from http.server import HTTPServer, BaseHTTPRequestHandler

import dateparser

PORT_FILE = os.path.join(tempfile.gettempdir(), 'claude2bot', 'ml-port')
BASE_PORT = 3360
MAX_PORT = 3367


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # All logs to stderr only
        sys.stderr.write(f"[temporal] {args[0]}\n")

    def do_POST(self):
        if self.path == '/temporal':
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            text = body.get('text', '')
            lang = body.get('lang', None)

            parsed = []
            if text:
                settings = {'PREFER_DATES_FROM': 'past', 'RETURN_AS_TIMEZONE_AWARE': False}

                # Try full text first
                result = dateparser.parse(text, languages=[lang] if lang else None, settings=settings)
                if result:
                    parsed.append({'text': text, 'start': result.strftime('%Y-%m-%d'), 'end': None})
                else:
                    # Extract temporal tokens and try each
                    TEMPORAL_KO = ['어제', '오늘', '내일', '그저께', '엊그제', '모레', '아까',
                                   '방금', '지난주', '이번주', '다음주', '지난달', '이번달', '다음달',
                                   '작년', '올해', '내년', '그제', '지난번']
                    for token in TEMPORAL_KO:
                        if token in text:
                            r = dateparser.parse(token, languages=['ko'], settings=settings)
                            if r:
                                parsed.append({'text': token, 'start': r.strftime('%Y-%m-%d'), 'end': None})
                                break
                    # Also try N일/주/달 전 patterns
                    if not parsed:
                        import re
                        m = re.search(r'(\d+)\s*(일|주|달|개월|년)\s*전', text)
                        if m:
                            r = dateparser.parse(f"{m.group(1)} {m.group(2)} 전", languages=['ko'], settings=settings)
                            if r:
                                parsed.append({'text': m.group(0), 'start': r.strftime('%Y-%m-%d'), 'end': None})

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'parsed': parsed}).encode())
            return

        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'ok', 'service': 'temporal-parser'}).encode())
            return

        self.send_response(404)
        self.end_headers()


def write_port_file(port):
    os.makedirs(os.path.dirname(PORT_FILE), exist_ok=True)
    with open(PORT_FILE, 'w') as f:
        f.write(str(port))


def cleanup(*_):
    try:
        os.remove(PORT_FILE)
    except OSError:
        pass
    sys.exit(0)


def main():
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    port = BASE_PORT
    while port <= MAX_PORT:
        try:
            server = HTTPServer(('127.0.0.1', port), Handler)
            break
        except OSError:
            port += 1
    else:
        sys.stderr.write(f"[temporal] all ports {BASE_PORT}-{MAX_PORT} in use\n")
        sys.exit(1)

    write_port_file(port)
    sys.stderr.write(f"[temporal] listening on port {port}\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        cleanup()


if __name__ == '__main__':
    main()
