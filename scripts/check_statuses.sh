#!/bin/bash
sshpass -p 'ekg9ENyLj3aGXNgiQ6CW' ssh -o StrictHostKeyChecking=no root@165.227.241.81 \
  'docker exec accu-mk1-backend python3 -c "
import sqlite3
conn = sqlite3.connect(\"/app/data/accu_mk1.db\")
cur = conn.cursor()
cur.execute(\"SELECT status, COUNT(*) FROM orders GROUP BY status\")
for r in cur.fetchall(): print(r)
print(\"---\")
cur.execute(\"SELECT order_number, status, created_at FROM orders WHERE status != '\"'\"'accepted'\"'\"' ORDER BY created_at DESC LIMIT 20\")
for r in cur.fetchall(): print(r)
conn.close()
"'
