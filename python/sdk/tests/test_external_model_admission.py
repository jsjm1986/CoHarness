from __future__ import annotations

import json
from pathlib import Path
import subprocess

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
FIXTURES = ROOT / 'examples' / 'headless-agent' / 'tests' / 'fixtures'
SNAPSHOTS = ROOT / 'packages' / 'test-support' / 'session-snapshot' / 'lib' / 'index.js'


@pytest.mark.skipif(not CLI.exists() or not SNAPSHOTS.exists(), reason='requires built dsh and fixture preparation')
@pytest.mark.parametrize(('fixture_name', 'response', 'event_type'), [
    ('external-model-admission', 'EXTERNAL_MODELS_REFUSED', 'plugin:external-model-admission/complete'),
    ('sdk-remote-target', 'SDK_REMOTE_TARGET_REFUSED', 'plugin:sdk-remote-target/complete'),
])
def test_external_model_admission(tmp_path: Path, fixture_name: str, response: str, event_type: str) -> None:
    fixture = FIXTURES / fixture_name
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
        result = harness.run(prepared['task'], session_id='external-control-owner')
        assert result.final_response == response
        completion = next(event['data'] for event in result.events
                          if event['type'] == event_type)
        assert completion == json.loads((fixture / 'expected.json').read_text())
