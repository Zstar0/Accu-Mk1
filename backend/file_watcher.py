"""
File watcher for monitoring HPLC export directories.

Uses watchdog library for cross-platform file system monitoring.
"""

import threading
from pathlib import Path
from typing import Callable, Optional

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileCreatedEvent


class HPLCFileHandler(FileSystemEventHandler):
    """Handle new file events in watched directory."""

    def __init__(self, callback: Callable[[str], None], extensions: list[str]):
        self.callback = callback
        self.extensions = extensions

    def on_created(self, event: FileCreatedEvent):
        if not event.is_directory:
            path = Path(event.src_path)
            if path.suffix.lower() in self.extensions:
                self.callback(str(path))


class FileWatcher:
    """
    Watch a directory for new HPLC export files.

    Uses watchdog library for cross-platform file system monitoring.
    """

    def __init__(self):
        self.observer: Optional[Observer] = None
        self.watch_path: Optional[str] = None
        self.detected_files: list[str] = []
        self.is_running = False
        self._lock = threading.Lock()

    def start(self, directory: str, extensions: list[str] = None):
        """Start watching directory for new files."""
        if extensions is None:
            extensions = [".txt"]

        if self.is_running:
            self.stop()

        self.watch_path = directory
        self.detected_files = []

        handler = HPLCFileHandler(self._on_file_detected, extensions)
        self.observer = Observer()
        self.observer.schedule(handler, directory, recursive=False)
        self.observer.start()
        self.is_running = True

    def stop(self):
        """Stop watching directory."""
        if self.observer:
            self.observer.stop()
            self.observer.join()
            self.observer = None
        self.is_running = False

    def _on_file_detected(self, file_path: str):
        """Callback when new file detected."""
        with self._lock:
            if file_path not in self.detected_files:
                self.detected_files.append(file_path)

    def get_detected_files(self) -> list[str]:
        """Get list of detected files and clear the list."""
        with self._lock:
            files = self.detected_files.copy()
            self.detected_files = []
            return files

    def status(self) -> dict:
        """Get watcher status."""
        return {
            "is_running": self.is_running,
            "watch_path": self.watch_path,
            "pending_files": len(self.detected_files),
        }
