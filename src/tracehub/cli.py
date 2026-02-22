"""
Script: cli.py
Created: 2026-02-22
Purpose: CLI entry point for TraceHub server
Keywords: cli, argparse, uvicorn, entrypoint, tracehub
Status: active
Prerequisites:
  - uvicorn
Changelog:
  - 2026-02-22: Extracted from server.py during package refactor
See-Also: .claude/CLAUDE.md ##Управление скриптами
"""

import os

from .config import TRACEHUB_DB, TRACEHUB_PORT, TRACEHUB_RETENTION_HOURS


def main():
    """CLI entry point for tracehub-server command."""
    import uvicorn
    import argparse

    parser = argparse.ArgumentParser(
        description="TraceHub - Centralized checkpoint trace collection server"
    )
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=TRACEHUB_PORT, help=f"Port to bind (default: {TRACEHUB_PORT})")
    parser.add_argument("--db", default=None, help=f"SQLite database path (default: {TRACEHUB_DB})")

    args = parser.parse_args()

    # Override from args
    db_path = args.db or TRACEHUB_DB
    if args.db:
        os.environ["TRACEHUB_DB"] = args.db

    print(f"TraceHub v1.0.0 - https://muid.io")
    print(f"Starting on {args.host}:{args.port}")
    print(f"Database: {db_path}")
    print(f"Retention: {TRACEHUB_RETENTION_HOURS} hours")

    from .app import app
    uvicorn.run(app, host=args.host, port=args.port)
