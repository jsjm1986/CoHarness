"""Project governed browser inference through the real Python SDK and built dsh profile."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
PREPARE = ROOT / 'snapshots' / 'sdk' / 'browser-use-stagehand-native' / 'prepare.mjs'
SNAPSHOTS = ROOT / 'packages' / 'test-support' / 'session-snapshot' / 'lib' / 'index.js'


@pytest.mark.skipif(not CLI.exists() or not SNAPSHOTS.exists(), reason='requires built dsh and snapshot fixture preparation')
def test_browser_model_snapshot(tmp_path: Path) -> None:
    prepared = json.loads(subprocess.run(
        ['node', str(PREPARE), str(tmp_path.resolve())],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout)
    with DeepSeekHarness(
        dsh_bin=str(CLI),
        dsh_home=str(tmp_path / '.dsh'),
        cwd=str(tmp_path),
        profile='sdk',
        patches=tuple(prepared['patches']),
        provider=prepared['provider'],
        model=prepared['model'],
        initialize_timeout_seconds=110,
        request_timeout_seconds=110,
        shutdown_timeout_seconds=30,
        env={
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_SNAPSHOT': 'replay',
            'DSH_SNAPSHOT_PROVIDER': prepared['provider'],
            'DSH_SNAPSHOT_MODEL': prepared['model'],
            'DSH_SNAPSHOT_FILE': prepared['replay'],
            'DSH_SNAPSHOT_OVERRIDE': prepared['override'],
            'DSH_AGENTS_HOME': str(tmp_path / '.agents'),
        },
    ) as harness:
        result = harness.run(prepared['task'])
    errors = [event['data']['message'] for event in result.events
              if event['type'] == 'tool/result' and event['data']['message'].get('isError')]
    assert not errors, errors
    requests = [event['data']['request'] for event in result.events
                if event['type'] == 'browser-use/stagehand-llm-request']
    actual = {'final_response': result.final_response, 'requests': requests}
    expected = Path(__file__).with_name('expected') / 'browser-model.json'
    assert actual == json.loads(expected.read_text())
