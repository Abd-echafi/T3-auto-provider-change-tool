"""Probe Codex advisory locks without creating, modifying, or removing files."""
import errno
import fcntl
import json
import os
import sys


def probe(home, thread_id):
    directory = os.path.join(home, "thread-writer-locks")
    if not os.path.isdir(directory):
        return {"status": "unknown", "reason": "writer lock directory is unavailable"}
    # Codex coordinates creation/deletion of thread locks through this file.
    # Taking its shared lock prevents a probe of an unlinked, obsolete inode.
    coordination = os.open(os.path.join(directory, ".coordination.lock"), os.O_RDONLY)
    try:
        try:
            fcntl.flock(coordination, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "held", "reason": "Codex is coordinating writer ownership"}
        try:
            writer = os.open(os.path.join(directory, thread_id + ".lock"), os.O_RDONLY)
        except FileNotFoundError:
            return {"status": "free"}
        try:
            try:
                fcntl.flock(writer, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                if error.errno in (errno.EAGAIN, errno.EACCES):
                    return {"status": "held", "reason": "another Codex client holds the conversation writer"}
                raise
            fcntl.flock(writer, fcntl.LOCK_UN)
            return {"status": "free"}
        finally:
            os.close(writer)
    finally:
        os.close(coordination)


try:
    home, thread_id = sys.argv[1:]
    print(json.dumps(probe(home, thread_id)))
except (OSError, ValueError):
    print(json.dumps({"status": "unknown", "reason": "could not inspect the Codex writer lock"}))
