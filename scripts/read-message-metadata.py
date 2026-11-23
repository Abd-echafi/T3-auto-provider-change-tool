"""Read maintenance metadata omitted from T3's bounded projection (no prompt text)."""
import json
from pathlib import Path
import sqlite3
import sys

database, thread_id, run_id, message_id = sys.argv[1:]
connection = sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
try:
    row = connection.execute(
        """SELECT json_extract(payload_json, '$.id'),
                  json_extract(payload_json, '$.role'),
                  json_extract(payload_json, '$.idleCompaction')
           FROM orchestration_v2_projection_messages
           WHERE thread_id = ? AND run_id = ? AND message_id = ?""",
        (thread_id, run_id, message_id),
    ).fetchone()
    print(json.dumps(None if row is None else {"id": row[0], "role": row[1], "idleCompaction": row[2]}))
finally:
    connection.close()
