"""Restored inboxes remain untouched while new conversations use the built runtime."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess

import pytest

from deepseek_harness import DeepSeekHarness
from deepseek_harness.errors import JsonRpcError

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
FIXTURE = ROOT / 'examples' / 'headless-agent' / 'tests' / 'fixtures' / 'recovery'
PREPARATION = ROOT / 'packages' / 'boot' / 'app-boot' / 'lib' / 'index.js'


@pytest.mark.skipif(not CLI.exists() or not PREPARATION.exists(), reason='requires built CLI and recovery preparation')
def test_recovery_execution_expected(tmp_path: Path) -> None:
    expected = json.loads((FIXTURE / 'expected.json').read_text())
    process = subprocess.Popen(
        ['node', str(FIXTURE / 'prepare.mjs'), str(tmp_path.resolve())],
        cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    assert process.stdout is not None
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        line = pool.submit(process.stdout.readline).result(timeout=60)
        assert line, process.stderr.read() if process.stderr is not None else 'preparation exited'
        prepared = json.loads(line)
        denied = []
        with DeepSeekHarness(
            dsh_bin=str(CLI), profile='sdk-minimal', dsh_home=str(tmp_path / '.dsh'), cwd=str(tmp_path),
            patches=tuple(prepared['patches']), initialize_timeout_seconds=110,
            request_timeout_seconds=110, shutdown_timeout_seconds=30,
            env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_AGENTS_HOME': str(tmp_path / '.agents'),
                 'HGW_RECOVERY_POLICY_FILE': prepared['policyFile'], 'HGW_RECOVERY_POLICY_SHA256': prepared['policySha256'],
                 'DEEPSEEK_API_KEY': 'owned-recovery-fixture-key', 'DEEPSEEK_BASE_URL': prepared['baseURL']},
        ) as harness:
            for session_id in expected['denied']:
                with pytest.raises(JsonRpcError, match=r'read.only|recovery|subagent session'):
                    harness.resume_session(session_id)
                with pytest.raises(JsonRpcError, match=r'read.only|recovery|subagent session'):
                    harness.run('Do not execute.', session_id=session_id)
                denied.append(session_id)
            result = harness.run('Reply briefly.', session_id='new-after-recovery')
        output, error = process.communicate(timeout=30)
        assert process.returncode == 0, error
        actual = {**json.loads(output), 'denied': denied, 'finalResponse': result.final_response,
                  'finishReason': result.finish_reason, 'unreviewedPluginImports': 0}
        assert actual == expected
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=10)
        pool.shutdown(wait=True, cancel_futures=True)
