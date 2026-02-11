import os, sys
sys.path.insert(0, '/app')
from dotenv import load_dotenv
load_dotenv()
from integration_db import get_integration_db
from psycopg2.extras import RealDictCursor

with get_integration_db() as conn:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT status, COUNT(*) as cnt FROM order_submissions GROUP BY status ORDER BY cnt DESC")
        print("=== STATUS COUNTS ===")
        for r in cur.fetchall():
            print(f"  {r['status']}: {r['cnt']}")
        
        print("\n=== NON-ACCEPTED ORDERS ===")
        cur.execute("SELECT order_number, status, samples_expected, samples_delivered, created_at FROM order_submissions WHERE status != 'accepted' ORDER BY created_at DESC LIMIT 20")
        for r in cur.fetchall():
            print(f"  #{r['order_number']} | {r['status']} | {r['samples_expected']}/{r['samples_delivered']} delivered | {r['created_at']}")
