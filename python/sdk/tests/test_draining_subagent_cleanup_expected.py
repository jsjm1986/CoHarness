"""Runtime withdrawal joins transferred cleanup through the Python SDK."""
from __future__ import annotations
import json
from pathlib import Path
import subprocess
import pytest
from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
FIXTURE = ROOT / 'examples' / 'headless-agent' / 'tests' / 'fixtures' / 'draining-subagent-cleanup'
PREPARATION = ROOT / 'packages' / 'test-support' / 'session-snapshot' / 'lib' / 'index.js'


@pytest.mark.skipif(not CLI.exists() or not PREPARATION.exists(), reason='requires built CLI and fixture preparation')
@pytest.mark.parametrize('mode', ['withdrawal', 'replacement'])
def test_draining_subagent_cleanup_expected(tmp_path: Path, mode: str) -> None:
    prepared = json.loads(subprocess.run(
        ['node', str(FIXTURE / 'prepare.mjs'), str(tmp_path.resolve())],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout)
    expected = json.loads((FIXTURE / 'expected.json').read_text())
    with DeepSeekHarness(
        dsh_bin=str(CLI), profile='sdk-minimal', dsh_home=str(tmp_path / '.dsh'), cwd=str(tmp_path),
        patches=tuple(prepared['patches']), provider=prepared['provider'], model=prepared['model'],
        initialize_timeout_seconds=110, request_timeout_seconds=110, shutdown_timeout_seconds=30,
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_AGENTS_HOME': str(tmp_path / '.agents'), 'DSH_DRAINING_CLEANUP': mode},
    ) as harness:
        result = harness.run('Verify cleanup during runtime withdrawal.', session_id='draining-cleanup')
        assert result.final_response == expected['reply']
        assert json.loads((tmp_path / 'draining-cleanup-proof.json').read_text()) == expected[mode]
