"""Project the exact auxiliary authorization request through the real Python SDK."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import threading

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
FIXTURE = ROOT / 'examples' / 'headless-agent' / 'tests' / 'fixtures' / 'auto-review-model'
SNAPSHOTS = ROOT / 'packages' / 'test-support' / 'session-snapshot' / 'lib' / 'index.js'


@pytest.mark.skipif(not CLI.exists() or not SNAPSHOTS.exists(), reason='requires built dsh and fixture preparation')
def test_auto_review_model_expected(tmp_path: Path) -> None:
    prepared = json.loads(subprocess.run(
        ['node', str(FIXTURE / 'prepare.mjs'), str(tmp_path.resolve())],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout)
    with DeepSeekHarness(
        dsh_bin=str(CLI), profile='sdk-minimal', dsh_home=str(tmp_path / '.dsh'), cwd=str(tmp_path),
        patches=tuple(prepared['patches']), provider=prepared['provider'], model=prepared['model'],
        initialize_timeout_seconds=110, request_timeout_seconds=110, shutdown_timeout_seconds=30,
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_AGENTS_HOME': str(tmp_path / '.agents')},
    ) as harness:
        with harness.client.subscribe_session_notifications('review-fixture-session') as subscription:
            watchdog = threading.Timer(60, harness.close)
            watchdog.start()
            try:
                result = harness.run(prepared['task'], session_id='review-fixture-session')
                requests = []
                completion = None
                while completion is None:
                    notification = subscription.next()
                    if notification.method != 'session.event':
                        continue
                    event = notification.payload['event']
                    if event['type'] == 'plugin:auto-review-fixture/complete':
                        completion = event['data']
                    elif event['type'] == 'auto-review/request':
                        data = event['data']
                        request = data['request']
                        text = '\n'.join(block['text'] for message in request['messages']
                                         for block in message['content'] if block['type'] == 'text')
                        requests.append({
                            'type': event['type'], 'callId': data['callId'],
                            'provider': request['provider'], 'model': request['model'],
                            'temperature': request['temperature'], 'reasoningEffort': request['reasoningEffort'],
                            'containsPendingAction': 'PENDING_ACTION' in text,
                        })
                assert {'finalResponse': result.final_response, 'requests': requests, 'completion': completion} == json.loads(
                    (FIXTURE / 'expected.json').read_text())
                assert (tmp_path / 'reviewed.txt').read_text() == 'reviewed\n'
            finally:
                watchdog.cancel()
                watchdog.join()
        harness.close()
        with DeepSeekHarness(harness.config) as continued:
            session = continued.resume_session('review-fixture-session')
            assert session.run('Write the owned fixture file again.').final_response == 'REVIEW_DONE'
    assert (tmp_path / 'reviewed.txt').read_text() == 'reviewed\nreviewed\n'
