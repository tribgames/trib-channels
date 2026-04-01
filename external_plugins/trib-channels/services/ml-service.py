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

PORT_FILE = os.path.join(tempfile.gettempdir(), 'trib-channels', 'ml-port')
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

                # Try full text parse
                result = dateparser.parse(text, languages=[lang] if lang else None, settings=settings)
                if result:
                    parsed.append({'text': text, 'start': result.strftime('%Y-%m-%d'), 'end': None})
                else:
                    # Try search_dates (finds dates within text)
                    try:
                        from dateparser.search import search_dates
                        found = search_dates(text, languages=[lang] if lang else None, settings=settings)
                        if found:
                            parsed.append({'text': found[0][0], 'start': found[0][1].strftime('%Y-%m-%d'), 'end': None})
                    except Exception:
                        pass

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
