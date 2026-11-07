"""Retain managed Auto qualification through the shipped Python SDK tool loop."""
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
FIXTURE = ROOT / 'examples' / 'headless-agent' / 'tests' / 'fixtures' / 'auto-review-authority'
PREPARATION = ROOT / 'packages' / 'test-support' / 'session-snapshot' / 'lib' / 'index.js'
CASES = [(phase, change) for phase in ('directory', 'grant', 'physical', 'response')
         for change in ('revoke', 'replace')] + [('none', 'none'), ('adoption', 'adopt')]


@pytest.mark.skipif(not CLI.exists() or not PREPARATION.exists(), reason='requires built dsh and fixture preparation')
@pytest.mark.parametrize(('phase', 'change'), CASES)
def test_auto_review_authority_expected(tmp_path: Path, phase: str, change: str) -> None:
    prepared = json.loads(subprocess.run(
        ['node', str(FIXTURE / 'prepare.mjs'), str(tmp_path.resolve())],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout)
    with DeepSeekHarness(
        dsh_bin=str(CLI), profile='sdk-minimal', dsh_home=str(tmp_path / '.dsh'), cwd=str(tmp_path),
        patches=tuple(prepared['patches']), provider=prepared['provider'], model=prepared['model'],
        initialize_timeout_seconds=110, request_timeout_seconds=110, shutdown_timeout_seconds=30,
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_AGENTS_HOME': str(tmp_path / '.agents'),
             'DSH_AUTO_AUTHORITY_PHASE': phase, 'DSH_AUTO_AUTHORITY_CHANGE': change},
    ) as harness:
        with ThreadPoolExecutor(max_workers=1) as worker:
            pending = worker.submit(harness.run, prepared['task'])
            try:
                if phase != 'none':
                    waiting = tmp_path / 'review-pending.json'
                    deadline = time.monotonic() + 30
                    while not waiting.exists():
                        if pending.done():
                            pending.result()
                            pytest.fail('SDK completed before the requested review waiting point')
                        if time.monotonic() >= deadline:
                            pytest.fail('Auto review did not enter its requested waiting point')
                        time.sleep(0.01)
                    assert json.loads(waiting.read_text()) == {'phase': phase, 'change': change}
                    (tmp_path / 'review-continue').write_text('released')
                assert pending.result(timeout=60).final_response == 'AUTO_AUTHORITY_DONE'
                expected = json.loads((FIXTURE / 'expected.json').read_text())[f'{phase}/{change}']
                assert json.loads((tmp_path / 'review-observation.json').read_text()) == expected
                if phase == 'none':
                    assert (tmp_path / 'reviewed.txt').read_text() == 'reviewed\n'
                else:
                    assert not (tmp_path / 'reviewed.txt').exists()
            finally:
                (tmp_path / 'review-continue').write_text('released')
