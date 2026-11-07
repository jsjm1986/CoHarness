"""Project all memory model requests through the real Python SDK and built runtime."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import threading

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
FIXTURE = ROOT / 'snapshots' / 'sdk' / 'memory-auxiliary'
SNAPSHOTS = ROOT / 'packages' / 'test-support' / 'session-snapshot' / 'lib' / 'index.js'


@pytest.mark.skipif(not CLI.exists() or not SNAPSHOTS.exists(), reason='requires built dsh and fixture preparation')
def test_memory_model_snapshot(tmp_path: Path) -> None:
    prepared = json.loads(subprocess.run(
        ['node', str(FIXTURE / 'prepare.mjs'), str(tmp_path.resolve())],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout)
    with DeepSeekHarness(
        dsh_bin=str(CLI), profile='sdk-minimal',
        dsh_home=str(tmp_path / '.dsh'), cwd=str(tmp_path),
        patches=tuple(prepared['patches']), provider=prepared['provider'], model=prepared['model'],
        initialize_timeout_seconds=110, request_timeout_seconds=110, shutdown_timeout_seconds=30,
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_AGENTS_HOME': str(tmp_path / '.agents')},
    ) as harness:
        with harness.client.subscribe_session_notifications('memory-fixture-session') as subscription:
            watchdog = threading.Timer(60, harness.close)
            watchdog.start()
            try:
                result = harness.run(prepared['task'], session_id='memory-fixture-session')
                requests = []
                completion = None
                while completion is None:
                    notification = subscription.next()
                    if notification.method != 'session.event':
                        continue
                    event = notification.payload['event']
                    if event['type'] == 'plugin:memory-fixture/complete':
                        completion = event['data']
                        continue
                    if event['type'] not in ('memory/recall-request', 'memory/curation-request'):
                        continue
                    data = event['data']
                    request = data['request']
                    text = '\n'.join(block['text'] for message in request['messages']
                                     for block in message['content'] if block['type'] == 'text')
                    projected = {
                        'type': event['type'], 'provider': request['provider'], 'model': request['model'],
                        'maxTokens': request['maxTokens'], 'reasoningEffort': request['reasoningEffort'],
                        'containsSeedMemory': 'release-freeze' in text,
                    }
                    if event['type'] == 'memory/curation-request':
                        projected.update(kind=data['kind'], round=data['round'])
                    requests.append(projected)
                actual = {'finalResponse': result.final_response, 'requests': requests, 'completion': completion}
                assert actual == json.loads((FIXTURE / 'expected.json').read_text())
            finally:
                watchdog.cancel()
                watchdog.join()
        harness.close()
        with DeepSeekHarness(harness.config) as continued:
            session = continued.resume_session('memory-fixture-session')
            assert session.run(prepared['task']).final_response == 'MEMORY_DONE'
