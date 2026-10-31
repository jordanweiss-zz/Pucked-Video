"""Start Pucked Video's server: python -m server [--port 8765]. Then open the address it prints."""
from __future__ import annotations

import argparse
import sys


def main() -> None:
    parser = argparse.ArgumentParser(prog='python -m server', description="Pucked Video's server")
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()

    import uvicorn

    from .app import app

    print(f'Pucked Video is running at http://127.0.0.1:{args.port}/', flush=True)
    sys.stdout.flush()
    uvicorn.run(app, host='127.0.0.1', port=args.port, log_level='warning')


if __name__ == '__main__':
    main()
