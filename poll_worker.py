#!/usr/bin/env python3
import os, time, json, urllib.request, sys

API_KEY = os.environ.get("RUNPOD_API_KEY", "")
ENDPOINT = os.environ.get("RUNPOD_ENDPOINT_ID", "w8h6kiymam2pcf")
JOB_ID = sys.argv[1] if len(sys.argv) > 1 else "86fb3c3e-ff49-409e-a517-e88e7b1c3ec2-e2"
HEADERS = {"Authorization": f"Bearer {API_KEY}"}

def get(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

for i in range(80):
    try:
        health = get(f"https://api.runpod.ai/v2/{ENDPOINT}/health")
        w = health["workers"]
        status = get(f"https://api.runpod.ai/v2/{ENDPOINT}/status/{JOB_ID}")
        s = status.get("status", "?")
        print(f"{time.strftime('%H:%M:%S')} job={s} | idle={w['idle']} init={w['initializing']} run={w['running']} thr={w['throttled']} bad={w['unhealthy']}", flush=True)
        if s in ("COMPLETED", "FAILED", "CANCELLED"):
            print(json.dumps(status, indent=2))
            break
    except Exception as e:
        print(f"{time.strftime('%H:%M:%S')} ERROR: {e}", flush=True)
    time.sleep(30)
