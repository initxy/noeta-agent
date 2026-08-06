"""The HTTP surface: `/api/v1/*` REST plus the per-session SSE stream.

This is the only layer with a network surface, and the frontend-backend wire
is the product contract (see `CONTEXT.md`). Every module here registers on the
single router in `router.py`.
"""
