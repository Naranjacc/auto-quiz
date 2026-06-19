"""
mitmproxy addon — auto-capture WeChat quiz credentials for auto-quiz.

Intercepts traffic to fengchuanba.com / fengxueba.com (quiz platforms).
Extracts userId, uuid, wxc, secretBoxCode, secretKey, baseUrl.
Saves directly to ~/.auto-quiz-session.json and updates profile.

Usage:
  mitmdump -s scripts/capture_addon.py --listen-port 8899
  mitmweb  -s scripts/capture_addon.py --listen-port 8899   # with web UI

Setup (one-time):
  1. Install mitmproxy: https://mitmproxy.org/downloads/
  2. Set phone WiFi proxy → this computer's IP : 8899
  3. Install CA cert on phone: open http://mitm.it in phone browser
  4. Run this script
  5. Open quiz link in WeChat → credentials auto-captured
"""

import json
import os
import re
from pathlib import Path
from mitmproxy import http, ctx

# ---- Config ----
QUIZ_DOMAINS = ["fengchuanba.com", "fengxueba.com", "fengchuanba.cn", "fengxueba.cn"]
SESSION_FILE = Path.home() / ".auto-quiz-session.json"
PROFILE_FILE = Path.home() / ".auto-quiz" / "profiles.json"

# ---- Credential patterns ----
URL_PATTERNS = [
    (r'[?&]code=([\w\-]+)',           'wxc'),
    (r'[?&]openid=([\w\-]+)',         'uuid'),
    (r'[?&]userId=(\d+)',              'userId'),
]

BODY_PATTERNS = [
    (r'"wxc"\s*:\s*"([^"]+)"',        'wxc'),
    (r'"uuid"\s*:\s*"([^"]+)"',       'uuid'),
    (r'"userId"\s*:\s*"([^"]+)"',     'userId'),
    (r'"openId"\s*:\s*"([^"]+)"',     'uuid'),
    (r'"openid"\s*:\s*"([^"]+)"',     'uuid'),
    (r'wxc=([\w\-]+)',                 'wxc'),
    (r'uuid=([\w\-]+)',                'uuid'),
    (r'userId=(\d+)',                  'userId'),
]

# ---- Captured credentials (in-memory) ----
captured = {}


def is_quiz_domain(host: str) -> bool:
    return any(d in host for d in QUIZ_DOMAINS)


def extract_from_text(text: str, patterns: list) -> dict:
    result = {}
    for pattern, field in patterns:
        if field not in result:  # first match wins
            m = re.search(pattern, text)
            if m:
                result[field] = m.group(1)
    return result


def extract_quiz_config(url: str) -> dict:
    """Extract secretBoxCode, secretKey, baseUrl from quiz URL."""
    # URL: https://host/path#secretBoxCode-secretKey
    m = re.search(r'#(\d+)-([a-zA-Z0-9]+)', url)
    if not m:
        return {}
    host_m = re.search(r'https?://([^/?#]+)', url)
    return {
        'secretBoxCode': m.group(1),
        'secretKey': m.group(2),
        'baseUrl': f'https://{host_m.group(1)}' if host_m else None,
    }


def save_credentials(new_creds: dict):
    """Write captured credentials to ~/.auto-quiz-session.json."""
    existing = {}
    if SESSION_FILE.exists():
        try:
            existing = json.loads(SESSION_FILE.read_text(encoding='utf-8'))
        except Exception:
            pass

    merged = {**existing, **new_creds}
    SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
    SESSION_FILE.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding='utf-8')
    ctx.log.info(f"✅ Credentials saved to {SESSION_FILE}")


def update_profile_if_match(quiz_config: dict, creds: dict):
    """Update matching profile with fresh credentials."""
    if not quiz_config.get('baseUrl') or not PROFILE_FILE.exists():
        return
    try:
        profiles = json.loads(PROFILE_FILE.read_text(encoding='utf-8'))
        updated = False
        for name, p in profiles.get('profiles', {}).items():
            if p.get('baseUrl') == quiz_config['baseUrl'] and \
               p.get('secretBoxCode') == quiz_config['secretBoxCode']:
                p['session'] = {**p.get('session', {}), **creds}
                ctx.log.info(f'✅ Updated profile "{name}" with fresh credentials')
                updated = True
        if updated:
            PROFILE_FILE.write_text(json.dumps(profiles, ensure_ascii=False, indent=2), encoding='utf-8')
    except Exception as e:
        ctx.log.error(f"Failed to update profile: {e}")


# ===== mitmproxy hooks =====

def request(flow: http.HTTPFlow) -> None:
    """Intercept requests to quiz domains."""
    host = flow.request.pretty_host
    url = flow.request.pretty_url
    method = flow.request.method

    if not is_quiz_domain(host):
        return

    # Log all quiz-related requests for visibility
    ctx.log.info(f"[quiz] {method} {url[:150]}")

    # Extract from URL
    url_creds = extract_from_text(url, URL_PATTERNS)

    # Extract from request body
    body = flow.request.get_text()
    body_creds = {}
    if body:
        body_creds = extract_from_text(body, BODY_PATTERNS)

    # Merge
    new_creds = {**body_creds, **url_creds}  # URL wins (OAuth code from redirect)
    quiz_config = extract_quiz_config(url)

    if new_creds:
        ctx.log.info(f"🎯 Credentials found: {json.dumps(new_creds, ensure_ascii=False)}")
        save_credentials(new_creds)
        if quiz_config:
            update_profile_if_match(quiz_config, new_creds)

    if quiz_config:
        ctx.log.info(f"📋 Quiz config: {json.dumps(quiz_config, ensure_ascii=False)}")


def response(flow: http.HTTPFlow) -> None:
    """Check response bodies for credentials (e.g. JSON with openId)."""
    host = flow.request.pretty_host
    if not is_quiz_domain(host):
        return

    try:
        body = flow.response.get_text()
        if body:
            resp_creds = extract_from_text(body, BODY_PATTERNS)
            if resp_creds:
                ctx.log.info(f"🎯 Credentials in response: {json.dumps(resp_creds, ensure_ascii=False)}")
                save_credentials(resp_creds)
    except Exception:
        pass  # Binary or unreadable response body


def done():
    """Called when mitmproxy shuts down."""
    if captured:
        ctx.log.info("=" * 50)
        ctx.log.info("📋 CAPTURE SUMMARY")
        ctx.log.info(f"   Credentials: {json.dumps(captured, ensure_ascii=False)}")
        ctx.log.info(f"   Session saved to: {SESSION_FILE}")
        ctx.log.info("=" * 50)
    else:
        ctx.log.info("=" * 50)
        ctx.log.info("⚠️  No quiz credentials captured.")
        ctx.log.info("   Make sure you:")
        ctx.log.info("   1. Opened the quiz link in WeChat")
        ctx.log.info("   2. Clicked '开始答题' (start quiz)")
        ctx.log.info("   3. Phone proxy is set correctly")
        ctx.log.info("=" * 50)
