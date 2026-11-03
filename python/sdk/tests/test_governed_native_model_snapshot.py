"""Project actual native model HTTP and durable input through the Python SDK."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import threading
from urllib.parse import urlparse

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
FIXTURES = ROOT / 'examples' / 'headless-agent' / 'tests' / 'fixtures'
SNAPSHOTS = ROOT / 'packages' / 'test-support' / 'session-snapshot' / 'lib' / 'index.js'


@pytest.mark.skipif(not CLI.exists() or not SNAPSHOTS.exists(), reason='requires built dsh and fixture preparation')
@pytest.mark.parametrize('protocol', ['native', 'sonar'])
def test_governed_native_model_snapshot(tmp_path: Path, protocol: str) -> None:
    fixture = FIXTURES / f'governed-{protocol}-model'
    prepared = json.loads(subprocess.run(
        ['node', str(fixture / 'prepare.mjs'), str(tmp_path.resolve())],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout)
    with DeepSeekHarness(
        dsh_bin=str(CLI), profile='sdk-minimal', dsh_home=str(tmp_path / '.dsh'), cwd=str(tmp_path),
        patches=tuple(prepared['patches']), provider=prepared['provider'], model=prepared['model'],
        initialize_timeout_seconds=110, request_timeout_seconds=110, shutdown_timeout_seconds=30,
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_AGENTS_HOME': str(tmp_path / '.agents')},
    ) as harness:
        with harness.client.subscribe_session_notifications('native-model-session') as subscription:
            watchdog = threading.Timer(60, harness.close)
            watchdog.start()
            try:
                result = harness.run(prepared['task'], session_id='native-model-session')
                requests = []
                completion = None
                while completion is None:
                    notification = subscription.next()
                    if notification.method != 'session.event':
                        continue
                    event = notification.payload['event']
                    if event['type'] == 'plugin:native-model-fixture/complete':
                        completion = event['data']
                    elif event['type'] == 'web/perplexity-search-llm-request':
                        data = event['data']
                        body = data['body']
                        requests.append({
                            'type': event['type'], 'path': urlparse(data['endpoint']).path,
                            'model': body['model'], 'maxTokens': body['max_tokens'], 'query': body['messages'][0]['content'],
                        })
                    elif event['type'] == 'web/deepseek-search-llm-request':
                        data = event['data']
                        body = data['body']
                        requests.append({
                            'type': event['type'], 'path': urlparse(data['endpoint']).path,
                            'apiVersion': data['apiVersion'], 'model': body['model'],
                            'maxTokens': body['max_tokens'], 'query': body['messages'][0]['content'][0]['text'],
                        })
                assert {'finalResponse': result.final_response, 'requests': requests, 'completion': completion} == json.loads(
                    (fixture / 'expected.json').read_text())
            finally:
                watchdog.cancel()
                watchdog.join()
        harness.close()
        with DeepSeekHarness(harness.config) as continued:
            session = continued.resume_session('native-model-session')
            assert session.run('Search the native fixture again.').final_response == 'NATIVE_SEARCH_DONE'
