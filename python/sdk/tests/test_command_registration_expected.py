"""Command registration ownership through the Python SDK application."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
FIXTURE = ROOT / 'examples' / 'headless-agent' / 'tests' / 'fixtures' / 'command-registration'
PREPARATION = ROOT / 'packages' / 'test-support' / 'session-snapshot' / 'lib' / 'index.js'


@pytest.mark.skipif(not CLI.exists() or not PREPARATION.exists(), reason='requires built CLI and fixture preparation')
def test_command_registration_expected(tmp_path: Path) -> None:
    prepared = json.loads(subprocess.run(
        ['node', str(FIXTURE / 'prepare.mjs'), str(tmp_path.resolve())],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout)
    expected = json.loads((FIXTURE / 'expected.json').read_text())
    with DeepSeekHarness(
        dsh_bin=str(CLI), profile='sdk-minimal', dsh_home=str(tmp_path / '.dsh'), cwd=str(tmp_path),
        patches=tuple(prepared['patches']), provider=prepared['provider'], model=prepared['model'],
        initialize_timeout_seconds=110, request_timeout_seconds=110, shutdown_timeout_seconds=30,
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_AGENTS_HOME': str(tmp_path / '.agents')},
    ) as harness:
        result = harness.run('Verify command registration ownership.', session_id='command-registration')
        assert result.final_response == expected['reply']
        assert json.loads((tmp_path / 'command-registration-proof.json').read_text()) == expected['proof']
