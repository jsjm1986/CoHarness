"""Verify Runtime-owned title admission and usage through the actual Python SDK."""
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
FIXTURE = ROOT / 'examples' / 'headless-agent' / 'tests' / 'fixtures' / 'title-infrastructure'
PREPARATION = ROOT / 'packages' / 'test-support' / 'session-snapshot' / 'lib' / 'index.js'
CASES = [(phase, caller) for phase in ('prepare', 'admission') for caller in ('same', 'foreign')]


@pytest.mark.skipif(not CLI.exists() or not PREPARATION.exists(), reason='requires built dsh and fixture preparation')
@pytest.mark.parametrize(('phase', 'caller'), CASES)
def test_title_infrastructure_expected(tmp_path: Path, phase: str, caller: str) -> None:
    prepared = json.loads(subprocess.run(
        ['node', str(FIXTURE / 'prepare.mjs'), str(tmp_path.resolve())],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout)
    with DeepSeekHarness(
        dsh_bin=str(CLI), profile='sdk-minimal', dsh_home=str(tmp_path / '.dsh'), cwd=str(tmp_path),
        patches=tuple(prepared['patches']), provider=prepared['provider'], model=prepared['model'],
        initialize_timeout_seconds=110, request_timeout_seconds=110, shutdown_timeout_seconds=30,
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_AGENTS_HOME': str(tmp_path / '.agents'),
             'DSH_TITLE_PHASE': phase, 'DSH_TITLE_CALLER': caller},
    ) as harness:
        with ThreadPoolExecutor(max_workers=1) as worker:
            pending = worker.submit(harness.run, 'Own the background Runtime title.', session_id='title-infrastructure')
            ready, observed = tmp_path / 'title-pending.json', tmp_path / 'title-observation.json'
            release = tmp_path / 'title-continue'
            deadline = time.monotonic() + 40
            try:
                while not ready.exists() and not observed.exists():
                    if pending.done():
                        pending.result()
                    if time.monotonic() >= deadline:
                        pytest.fail('Title fixture did not reach its waiting point or settle')
                    time.sleep(0.01)
                if ready.exists():
                    assert json.loads(ready.read_text()) == {'phase': phase, 'caller': caller}
                    release.write_text('released')
                assert pending.result(timeout=60).final_response == 'TITLE_INFRASTRUCTURE_DONE'
                while not observed.exists():
                    if time.monotonic() >= deadline:
                        pytest.fail('Title fixture did not publish its usage observation')
                    time.sleep(0.01)
                expected = json.loads((FIXTURE / 'expected.json').read_text())[f'{phase}/{caller}']
                assert json.loads(observed.read_text()) == expected
            finally:
                release.write_text('released')
