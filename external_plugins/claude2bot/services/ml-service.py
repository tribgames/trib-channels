#!/usr/bin/env python3
"""ML microservice: embedding generation + temporal expression parsing."""

import json
import os
import signal
import socket
import sys
import tempfile
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler

import dateparser
from fastembed import TextEmbedding


# --- Configuration ---
DEFAULT_PORT = 3360
PORT_RANGE_END = 3367
MODEL_NAME = "BAAI/bge-m3"
PORT_FILE = os.path.join(tempfile.gettempdir(), "claude2bot", "ml-port")

# --- Global model reference ---
model: TextEmbedding | None = None
model_dims: int = 0


def find_available_port() -> int:
    """Find an available port in the configured range."""
    for port in range(DEFAULT_PORT, PORT_RANGE_END + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    print(f"No available port in {DEFAULT_PORT}-{PORT_RANGE_END}", file=sys.stderr)
    sys.exit(1)


def write_port_file(port: int) -> None:
    """Write the active port to the port file."""
    os.makedirs(os.path.dirname(PORT_FILE), exist_ok=True)
    with open(PORT_FILE, "w", encoding="utf-8") as f:
        f.write(str(port))


def remove_port_file() -> None:
    """Remove the port file on shutdown."""
    try:
        os.remove(PORT_FILE)
    except FileNotFoundError:
        pass


def load_model() -> None:
    """Load the fastembed model once at startup."""
    global model, model_dims
    print(f"Loading model {MODEL_NAME}...", file=sys.stderr)
    model = TextEmbedding(MODEL_NAME)
    test_vec = list(model.embed(["test"]))[0]
    model_dims = len(test_vec)
    print(f"Model loaded. dims={model_dims}", file=sys.stderr)


class MLHandler(BaseHTTPRequestHandler):
    """HTTP request handler for ML endpoints."""

    def log_message(self, format, *args):
        """Redirect all HTTP logs to stderr."""
        print(f"{self.address_string()} - {format % args}", file=sys.stderr)

    def _send_json(self, data: dict, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    # --- Routes ---

    def do_GET(self) -> None:
        if self.path == "/health":
            self._handle_health()
        else:
            self._send_json({"error": "Not found"}, 404)

    def do_POST(self) -> None:
        if self.path == "/embed":
            self._handle_embed()
        elif self.path == "/temporal":
            self._handle_temporal()
        else:
            self._send_json({"error": "Not found"}, 404)

    def _handle_health(self) -> None:
        self._send_json({"status": "ok", "model": MODEL_NAME, "dims": model_dims})

    def _handle_embed(self) -> None:
        try:
            body = self._read_body()

            # Batch mode
            texts = body.get("texts")
            if texts is not None:
                if not isinstance(texts, list) or len(texts) == 0:
                    self._send_json({"error": "texts must be a non-empty array"}, 400)
                    return
                vectors = list(model.embed(texts))
                self._send_json({
                    "vectors": [v.tolist() for v in vectors],
                    "dims": model_dims,
                })
                return

            # Single mode
            text = body.get("text")
            if not text or not isinstance(text, str):
                self._send_json({"error": "text is required"}, 400)
                return
            vector = list(model.embed([text]))[0]
            self._send_json({"vector": vector.tolist(), "dims": model_dims})

        except Exception as e:
            self._send_json({"error": str(e)}, 500)

    def _handle_temporal(self) -> None:
        try:
            body = self._read_body()
            text = body.get("text", "")
            lang = body.get("lang")

            if not text:
                self._send_json({"parsed": []})
                return

            settings = {"RETURN_AS_TIMEZONE_AWARE": False}
            if lang:
                settings["LANGUAGE_DETECTION_CONFIDENCE_THRESHOLD"] = 0
                languages = [lang]
            else:
                languages = None

            parsed_date = dateparser.parse(
                text,
                languages=languages,
                settings=settings,
            )

            if parsed_date is None:
                # Try extracting temporal tokens from the text
                results = []
                tokens = _extract_temporal_tokens(text, lang)
                for token_text, dt in tokens:
                    results.append({
                        "text": token_text,
                        "start": dt.strftime("%Y-%m-%d"),
                        "end": dt.strftime("%Y-%m-%d"),
                    })
                self._send_json({"parsed": results})
            else:
                self._send_json({"parsed": [{
                    "text": text,
                    "start": parsed_date.strftime("%Y-%m-%d"),
                    "end": parsed_date.strftime("%Y-%m-%d"),
                }]})

        except Exception as e:
            self._send_json({"error": str(e)}, 500)


# Korean temporal keywords for token extraction
_KO_TEMPORAL = {
    "오늘": 0, "어제": -1, "그제": -2, "그저께": -2,
    "내일": 1, "모레": 2,
    "지난주": -7, "이번주": 0, "다음주": 7,
    "지난달": -30, "이번달": 0, "다음달": 30,
    "작년": -365, "올해": 0, "내년": 365,
}


def _extract_temporal_tokens(text: str, lang: str | None):
    """Extract known temporal tokens from text and parse each."""
    from datetime import timedelta
    results = []
    now = datetime.now()

    if lang == "ko" or lang is None:
        for keyword, offset_days in _KO_TEMPORAL.items():
            if keyword in text:
                dt = now + timedelta(days=offset_days)
                results.append((keyword, dt))

    if not results:
        # Fallback: try dateparser on the whole text with PREFER_DATES_FROM=past
        settings = {
            "RETURN_AS_TIMEZONE_AWARE": False,
            "PREFER_DATES_FROM": "past",
        }
        dt = dateparser.parse(text, settings=settings)
        if dt:
            results.append((text, dt))

    return results


def main() -> None:
    load_model()

    port = find_available_port()
    server = HTTPServer(("127.0.0.1", port), MLHandler)
    write_port_file(port)
    print(f"ML service listening on 127.0.0.1:{port}", file=sys.stderr)

    def shutdown_handler(signum, frame):
        print("Shutting down...", file=sys.stderr)
        remove_port_file()
        server.shutdown()

    signal.signal(signal.SIGTERM, shutdown_handler)
    signal.signal(signal.SIGINT, shutdown_handler)

    try:
        server.serve_forever()
    finally:
        remove_port_file()


if __name__ == "__main__":
    main()
