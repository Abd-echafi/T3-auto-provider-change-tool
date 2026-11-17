"""Read one historical T3 0.1.9 failure for an in-memory diagnostic replay."""
import json
from pathlib import Path
import sqlite3
import sys

database, run_id = sys.argv[1:]
connection = sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True)
try:
    row = connection.execute(
        "SELECT payload_json FROM orchestration_v2_projection_runs WHERE run_id = ?", (run_id,)
    ).fetchone()
    if row is None:
        raise ValueError("Recorded run not found")
    run = json.loads(row[0])
    errors = [json.loads(row[0]) for row in connection.execute(
        "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE run_id = ? AND type = 'error'",
        (run_id,),
    )]
    row = connection.execute(
        "SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id = ?", (run["userMessageId"],)
    ).fetchone()
    message = json.loads(row[0]) if row else None
    # The replay needs identity and maintenance classification, not prompt text.
    if message is not None:
        message = {key: message[key] for key in ("id", "idleCompaction") if key in message}
    print(json.dumps({"run": run, "errors": errors, "message": message}))
finally:
    connection.close()
