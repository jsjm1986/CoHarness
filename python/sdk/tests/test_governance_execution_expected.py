"""Verify automatic compaction authority and durable billing through the real Python SDK."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import time

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
FIXTURE = ROOT / 'examples' / 'headless-agent' / 'tests' / 'fixtures' / 'governance-execution'
PREPARATION = ROOT / 'packages' / 'test-support' / 'session-snapshot' / 'lib' / 'index.js'
CASES = [(phase, change) for phase in ('preparation', 'grant', 'authorization', 'physical')
         for change in ('same', 'different')] + [('grant', 'inputs'), ('grant', 'primary'), ('none', 'none')]


@pytest.mark.skipif(not CLI.exists() or not PREPARATION.exists(), reason='requires built dsh and fixture preparation')
@pytest.mark.parametrize(('phase', 'change'), CASES)
def test_governance_execution_expected(tmp_path: Path, phase: str, change: str) -> None:
    prepared = json.loads(subprocess.run(
        ['node', str(FIXTURE / 'prepare.mjs'), str(tmp_path.resolve())],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout)
    with DeepSeekHarness(
        dsh_bin=str(CLI), profile='sdk-minimal', dsh_home=str(tmp_path / '.dsh'), cwd=str(tmp_path),
        patches=tuple(prepared['patches']), provider=prepared['provider'], model=prepared['model'],
        initialize_timeout_seconds=110, request_timeout_seconds=110, shutdown_timeout_seconds=30,
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_AGENTS_HOME': str(tmp_path / '.agents'),
             'DSH_GOVERNANCE_PHASE': phase, 'DSH_GOVERNANCE_CHANGE': change},
    ) as harness:
        assert harness.run('Preserve this project policy. ' * 1800,
                           session_id='governance-execution').final_response == 'GOVERNANCE_SEED_DONE'
        with ThreadPoolExecutor(max_workers=1) as worker:
            pending = worker.submit(harness.run, 'Continue the owned task.', session_id='governance-execution')
            try:
                if phase != 'none':
                    waiting = tmp_path / 'governance-pending.json'
                    deadline = time.monotonic() + 30
                    while not waiting.exists():
                        if pending.done():
                            pending.result()
                            pytest.fail('SDK completed before the requested governance waiting point')
                        if time.monotonic() >= deadline:
                            pytest.fail('Governance did not enter its requested waiting point')
                        time.sleep(0.01)
                    assert json.loads(waiting.read_text()) == {'phase': phase, 'change': change}
                    (tmp_path / 'governance-continue').write_text('released')
                assert pending.result(timeout=60).final_response == 'GOVERNANCE_NEXT_DONE'
                expected = json.loads((FIXTURE / 'expected.json').read_text())[f'{phase}/{change}']
                assert json.loads((tmp_path / 'governance-observation.json').read_text()) == expected
            finally:
                (tmp_path / 'governance-continue').write_text('released')
