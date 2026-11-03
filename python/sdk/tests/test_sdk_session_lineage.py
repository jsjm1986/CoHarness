"""Project actual three-level SDK ancestry with a one-frame notification queue."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess

import pytest
from pydantic import BaseModel

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
FIXTURES = ROOT / 'examples' / 'headless-agent' / 'tests' / 'fixtures'
SNAPSHOTS = ROOT / 'packages' / 'test-support' / 'session-snapshot' / 'lib' / 'index.js'


class WaitResponse(BaseModel):
    """Successful session/wait acknowledgement."""


@pytest.mark.skipif(not CLI.exists() or not SNAPSHOTS.exists(), reason='requires built dsh and fixture preparation')
def test_sdk_session_lineage(tmp_path: Path) -> None:
    fixture = FIXTURES / 'sdk-session-lineage'
    prepared = json.loads(subprocess.run(
        ['node', str(fixture / 'prepare.mjs'), str(tmp_path.resolve())],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout)
    with DeepSeekHarness(
        dsh_bin=str(CLI), profile='sdk-minimal', dsh_home=str(tmp_path / '.dsh'), cwd=str(tmp_path),
        patches=tuple(prepared['patches']), provider=prepared['provider'], model=prepared['model'],
        initialize_timeout_seconds=110, request_timeout_seconds=110, shutdown_timeout_seconds=30,
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_AGENTS_HOME': str(tmp_path / '.agents')},
        max_notification_queue=1,
    ) as harness:
        client = harness.client
        received = []

        def close_filter(_notification):
            closed.close()
            return True

        def drain_filter(_notification):
            sink.drain(lambda _item: None)
            tree.drain(received.append)
            return True

        closed = client.subscribe_notifications(close_filter)
        sink = client.subscribe_notifications(drain_filter)
        tree = client.subscribe_session_notifications('lineage-root')
        try:
            client.session_prompt('lineage-root', [{'type': 'text', 'text': 'root'}])
            client.request('session/wait', {'sessionId': 'lineage-root'}, response_model=WaitResponse)
            tree.drain(received.append)
            answers = []
            for notification in received:
                if notification.method != 'session.event':
                    continue
                event = notification.payload['event']
                if event['type'] == 'assistant/message':
                    answers.extend(block['text'] for block in event['data']['message']['content'] if block['type'] == 'text')
            assert answers == ['GRANDCHILD_DONE', 'CHILD_DONE', 'SDK_LINEAGE_DONE']
            assert len([item for item in received if item.method == 'subagent.started']) == 2
            late = []
            closed.drain(late.append)
            assert late == []
        finally:
            tree.close()
            sink.close()
            closed.close()
