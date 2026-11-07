"""Runtime withdrawal stops admission and joins physical startup rollback through the Python SDK."""
from __future__ import annotations
import json
from pathlib import Path
import subprocess
import pytest
from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
FIXTURE = ROOT / 'examples' / 'headless-agent' / 'tests' / 'fixtures' / 'withdrawn-subagent-admission'
PREPARATION = ROOT / 'packages' / 'test-support' / 'session-snapshot' / 'lib' / 'index.js'


@pytest.mark.skipif(not CLI.exists() or not PREPARATION.exists(), reason='requires built CLI and fixture preparation')
@pytest.mark.parametrize('mode', ['withdrawn', 'publishing', 'rollback-retry', 'holder'])
def test_withdrawn_subagent_admission_expected(tmp_path: Path, mode: str) -> None:
    prepared = json.loads(subprocess.run(
        ['node', str(FIXTURE / 'prepare.mjs'), str(tmp_path.resolve())],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout)
    expected = json.loads((FIXTURE / 'expected.json').read_text())
    with DeepSeekHarness(
        dsh_bin=str(CLI), profile='sdk-minimal', dsh_home=str(tmp_path / '.dsh'), cwd=str(tmp_path),
        patches=tuple(prepared['patches']), provider=prepared['provider'], model=prepared['model'],
        initialize_timeout_seconds=110, request_timeout_seconds=110, shutdown_timeout_seconds=30,
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_AGENTS_HOME': str(tmp_path / '.agents'), 'DSH_WITHDRAWAL_ADMISSION': mode},
    ) as harness:
        result = harness.run('Verify startup ownership during runtime withdrawal.', session_id='withdrawal-admission')
        assert result.final_response == expected['reply']
        assert json.loads((tmp_path / 'withdrawal-admission-proof.json').read_text()) == expected[mode]
