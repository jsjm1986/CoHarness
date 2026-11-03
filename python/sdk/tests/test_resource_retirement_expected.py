"""Unsent resource cancellation and origin failure through the actual Python SDK."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
FIXTURE = ROOT / 'examples' / 'headless-agent' / 'tests' / 'fixtures' / 'resource-retirement'
PREPARATION = ROOT / 'packages' / 'test-support' / 'session-snapshot' / 'lib' / 'index.js'


@pytest.mark.skipif(not CLI.exists() or not PREPARATION.exists(), reason='requires built CLI and fixture preparation')
@pytest.mark.parametrize('mode', ['origin-failure', 'cancel-before-registration', 'uncertain-owner', 'response-cancellation'])
def test_resource_retirement_expected(tmp_path: Path, mode: str) -> None:
    prepared = json.loads(subprocess.run(
        ['node', str(FIXTURE / 'prepare.mjs'), str(tmp_path.resolve())],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout)
    expected = json.loads((FIXTURE / 'expected.json').read_text())
    oracle = expected['responseCancellation'] if mode == 'response-cancellation' else expected['uncertainOwner'] if mode == 'uncertain-owner' else {
        'reply': expected['reply'], 'proof': {
            **expected['proof'], 'mode': mode,
            'reason': 'unavailable' if mode == 'origin-failure' else 'cancelled',
        },
    }
    with DeepSeekHarness(
        dsh_bin=str(CLI), profile='sdk-minimal', dsh_home=str(tmp_path / '.dsh'), cwd=str(tmp_path),
        patches=tuple(prepared['patches']), provider=prepared['provider'], model=prepared['model'],
        initialize_timeout_seconds=110, request_timeout_seconds=110, shutdown_timeout_seconds=30,
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_AGENTS_HOME': str(tmp_path / '.agents'),
             'DSH_RESOURCE_RETIREMENT': mode},
    ) as harness:
        result = harness.run('Check independent resource request ownership.', session_id='resource-retirement')
        assert result.final_response == oracle['reply']
        assert json.loads((tmp_path / 'resource-retirement-proof.json').read_text()) == oracle['proof']
