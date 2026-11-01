"""One sync at a time: a lock file in the index folder."""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path


class SyncBusy(ValueError):
    """Another sync holds the lock, or one stopped without releasing it."""


@contextmanager
def sync_lock(folder: Path) -> Iterator[None]:
    """Hold `<folder>/sync.lock` (it holds the process id) until the block ends,
    even when it fails. If the file exists, raise SyncBusy and leave it alone."""
    folder.mkdir(parents=True, exist_ok=True)
    lock = folder / "sync.lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise SyncBusy(
            f"Another sync is running in {folder}, or one stopped without finishing. "
            f"If none is running, delete {lock} and run it again."
        ) from None
    try:
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        yield
    finally:
        lock.unlink(missing_ok=True)
