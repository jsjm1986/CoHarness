"""Project actual Codex model requests and original parent usage through the Python SDK."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import threading

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
FIXTURES = ROOT / 'examples' / 'headless-agent' / 'tests' / 'fixtures'


@pytest.mark.skipif(not CLI.exists(), reason='requires built dsh and its native Codex dependency')
@pytest.mark.parametrize('directory', ['managed-codex-model', 'managed-codex-member'])
def test_managed_codex_model_snapshot(tmp_path: Path, directory: str) -> None:
    fixture = FIXTURES / directory
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
        with harness.client.subscribe_session_notifications('managed-codex-parent') as subscription:
            watchdog = threading.Timer(60, harness.close)
            watchdog.start()
            try:
                result = harness.run(prepared['task'], session_id='managed-codex-parent')
                requests = []
                completion = None
                member_id = None
                member_route = None
                while completion is None:
                    notice = subscription.next()
                    if notice.method != 'session.event':
                        continue
                    if notice.payload['sessionId'] != 'managed-codex-parent':
                        member_id = notice.payload['sessionId']
                    event = notice.payload['event']
                    if notice.payload['sessionId'] != 'managed-codex-parent' and event['type'] == 'request/header':
                        member_route = event['data']['header']['config']
                    if event['type'] == 'plugin:managed-codex-fixture/complete':
                        completion = event['data']
                    elif event['type'] == 'subagent/codex-model-request':
                        data = event['data']
                        requests.append({'provider': data['provider'], 'model': data['model'],
                                         'protocol': data['request']['protocol'],
                                         'bodyModel': data['request']['body']['model']})
                assert {'finalResponse': result.final_response, 'requests': requests, 'completion': completion} == json.loads(
                    (fixture / 'expected.json').read_text())
            finally:
                watchdog.cancel()
                watchdog.join()
        harness.close()
        if directory == 'managed-codex-member':
            assert member_id is not None and member_route is not None
        with DeepSeekHarness(harness.config) as resumed:
            # Member sessions refuse direct wire resume; resuming the root
            # restores the whole tree and re-drives the scripted continuation
            # to the same marker.
            session = resumed.resume_session('managed-codex-parent')
            expected = 'PARENT_CODEX_DONE'
            assert session.run('Run managed Codex again.').final_response == expected
