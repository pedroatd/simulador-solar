"""Servidor local del simulador (sin caché, para que los cambios en js/ se vean al recargar).

Uso:  python serve.py [puerto]   →  http://localhost:8765
"""
import http.server
import sys
import webbrowser
from functools import partial
from pathlib import Path


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = partial(NoCacheHandler, directory=str(Path(__file__).parent))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        url = f"http://localhost:{port}"
        print(f"Simulador en {url}  (Ctrl+C para parar)")
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
