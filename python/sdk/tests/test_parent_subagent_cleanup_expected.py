"""Session shutdown joins original native cleanup before the surrounding runtime ends."""
from __future__ import annotations
import json
from pathlib import Path
import subprocess
import pytest
from pydantic import BaseModel
from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
FIXTURE = ROOT / 'examples' / 'headless-agent' / 'tests' / 'fixtures' / 'parent-subagent-cleanup'
PREPARATION = ROOT / 'packages' / 'test-support' / 'session-snapshot' / 'lib' / 'index.js'


class ShutdownResponse(BaseModel):
    """Empty shutdown acknowledgement while the runtime remains connected."""


@pytest.mark.skipif(not CLI.exists() or not PREPARATION.exists(), reason='requires built CLI and fixture preparation')
@pytest.mark.parametrize('mode', ['workflow', 'ralph'])
@pytest.mark.parametrize('phase', ['live', 'retired'])
def test_parent_subagent_cleanup_expected(tmp_path: Path, mode: str, phase: str) -> None:
    prepared = json.loads(subprocess.run(
        ['node', str(FIXTURE / 'prepare.mjs'), str(tmp_path.resolve())],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout)
    expected = json.loads((FIXTURE / 'expected.json').read_text())
    with DeepSeekHarness(
        dsh_bin=str(CLI), profile='sdk-minimal', dsh_home=str(tmp_path / '.dsh'), cwd=str(tmp_path),
        patches=tuple(prepared['patches']), provider=prepared['provider'], model=prepared['model'],
        initialize_timeout_seconds=110, request_timeout_seconds=110, shutdown_timeout_seconds=30,
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_AGENTS_HOME': str(tmp_path / '.agents'),
             'DSH_PARENT_CLEANUP': mode, 'DSH_PARENT_CLEANUP_PHASE': phase},
    ) as harness:
        result = harness.run('Verify owned parent cleanup.', session_id='parent-cleanup')
        assert result.final_response == expected['reply']
        wanted = expected['cases'][mode + '-' + phase]
        assert json.loads((tmp_path / 'parent-cleanup-before.json').read_text()) == wanted['before']
        harness.client.request('shutdown', {}, response_model=ShutdownResponse)
        try:
            proof = json.loads((tmp_path / 'parent-cleanup-proof.json').read_text())
        except FileNotFoundError:
            proof = {'cleanupConfirmed': False}
        assert proof == wanted['after']
