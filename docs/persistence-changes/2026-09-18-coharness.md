---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-18-coharness

English | [中文](2026-09-18-coharness.zh.md)

## Summary

Establishes the complete CoHarness persistence-type inventory as the fork's tracking baseline, adopted during the dsh-v0.1.6-alpha.2 alignment.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-18-coharness
baseline: true
changes:
  - root: "JsonlHeaderLine"
    previous: null
    after: "60c867eea405c667777ee60bd958e5a0ffbb78f25efd886f683b49bdc8c26076"
    decision: same-version
  - root: "SessionEventEnvelope"
    previous: null
    after: "5776e5553ff2dfe3f5bc202dbb1e7c9f93e35a531aebb7764c23b2b6153b2ccc"
    decision: same-version
  - root: "SessionHeader"
    previous: null
    after: "38644be902f65a5f4579e23c9ac3778db8b74720447891db50c990b2ea0f3c60"
    decision: same-version
  - root: "event:agent-preset/selected"
    previous: null
    after: "a10c17474eaf2ddab7095a099e0fe3d046fc18e56c3e344fc8894c05ff9ef97b"
    decision: same-version
  - root: "event:agent/inbox/spliced"
    previous: null
    after: "63514070b004dcb3292a1235b7115091337070fd0caf7b93ac53ea65a8f61e22"
    decision: same-version
  - root: "event:approval/asked"
    previous: null
    after: "3bfeb47b58606f4661904bc723da612782214c463d01e6d61cd6d6193d7374e1"
    decision: same-version
  - root: "event:approval/decided"
    previous: null
    after: "bb1ab3d08f49a9f3b265f844cd78d5c49813062a7b34b54904b426f85d0ff6e3"
    decision: same-version
  - root: "event:approval/policy"
    previous: null
    after: "26718e15e7e395bce9642dba5bbe09b3b1a4ce2213d20d566cd9207d7fc5fb78"
    decision: same-version
  - root: "event:assistant/attempt"
    previous: null
    after: "d36662a79a132b1eb2cc848b83fc3c7d7d8c483a4163552b3b378ff98d9b8310"
    decision: same-version
  - root: "event:assistant/chunk"
    previous: null
    after: "36469494a2d68064b4bd05543e64bc9b01a1ae3e08eba44cffb0fd1fcd12730a"
    decision: same-version
  - root: "event:assistant/message"
    previous: null
    after: "7710ed6d031198bb5109e0bdaca911a3b65b22ab526dfe452785a2180d7107c7"
    decision: same-version
  - root: "event:command/done"
    previous: null
    after: "15196447222782e773eb943c92b18316ce96b9af0f0cfddb6e57ba8274ecc5ff"
    decision: same-version
  - root: "event:command/run"
    previous: null
    after: "37184378c6439257d105c4e2022d80fc9c3a3f7c7f6ac661b00bc9f18d871006"
    decision: same-version
  - root: "event:compaction/end"
    previous: null
    after: "b0127044ab31a702bddfd785d345f5abd7a70876746e895ce443afa3e60ddf2d"
    decision: same-version
  - root: "event:compaction/prune"
    previous: null
    after: "7f7fd5a6b0064f597534b29ff62ef26e786dffccf5e14f654a7d4fcea2c35f04"
    decision: same-version
  - root: "event:compaction/start"
    previous: null
    after: "db874d463b0fdec77e9da1c4568f37cb70bd6596781eb93800db44fb8a116965"
    decision: same-version
  - root: "event:compaction/summary"
    previous: null
    after: "85c28ce3efec5863a9bf4b22ae57a50a03ec5337b965ee95ff77c9b9d137fa22"
    decision: same-version
  - root: "event:feedback/message-delete"
    previous: null
    after: "7641b74a731237003b2cff1e72e21ea4b9c1b23e59f1c83a337dab25b2932d2f"
    decision: same-version
  - root: "event:feedback/message-put"
    previous: null
    after: "3b04fde0dc763cf84fbde7b6611b3194dd56d95d0c0bf0204311640468d586e1"
    decision: same-version
  - root: "event:feedback/record"
    previous: null
    after: "b54940ff095c17e874c5be03815f4c2145a256cf3a1d34dae4ab2f7769dfffe8"
    decision: same-version
  - root: "event:goal/change"
    previous: null
    after: "763c8a20af487263a0080548274f7437ef4a86e0ba8769127d1ced10a72c664d"
    decision: same-version
  - root: "event:hook/invoked"
    previous: null
    after: "8a6e1ec9e8db346b0e02f027db73c07a94f067a26d40c1aef1abd09c47ce7ba0"
    decision: same-version
  - root: "event:hook/result"
    previous: null
    after: "e75916628f3f10c2d50658bd143052a46285fbf1a9a700ba54947614603d26b4"
    decision: same-version
  - root: "event:llm/retry"
    previous: null
    after: "91c397f8f870e812e1dc5ac69c2745f9f105be9dc97dadc980d19ef415a65145"
    decision: same-version
  - root: "event:llm/retry-started"
    previous: null
    after: "48e5c9861f16ac07e78cb7b5ae9dabdf7bb85c58baed5a51b4ad275050ea58e3"
    decision: same-version
  - root: "event:model/selection"
    previous: null
    after: "35203ba7ad5ef6f97d556b85df20ae98f04f09c65748cecdf8eefdb8b6405ffc"
    decision: same-version
  - root: "event:permission/preset"
    previous: null
    after: "7271e4b771406aaf06014c2269edd6cb68055bb8b8686571730813ce0ababc22"
    decision: same-version
  - root: "event:plan/mode"
    previous: null
    after: "a7cf43ce7c2a4c038feed1885cd7a00d5c6ee2d90a7e0d56b46f78a3e1ca327f"
    decision: same-version
  - root: "event:request/context"
    previous: null
    after: "37cbc9cf06d494cfe5c67f078af1605eacb8e4c2c853e9e26455b73de0ee7ccf"
    decision: same-version
  - root: "event:request/header"
    previous: null
    after: "7f6979357e4d33950083b4d5474907d092113a0bc1e60eb827579b61cbc00201"
    decision: same-version
  - root: "event:sandbox/mode"
    previous: null
    after: "516da4cdd6d2f1e5ce488e648578ca51f40e458f707b803e5b24de870e799415"
    decision: same-version
  - root: "event:schedule/change"
    previous: null
    after: "2a7f86849ae54b3398ee49661a757c4fcb59a6192b7036ee2ff514617e13fb42"
    decision: same-version
  - root: "event:session-log-deepseek/delivery-accepted"
    previous: null
    after: "d63b8b8ffad9c02fd80c43a17df4f240c1fe8118ecca9de34f9d5871838ab5b9"
    decision: same-version
  - root: "event:session/end-seed"
    previous: null
    after: "669846d6f47138d4b8897717b0f08476805437a4b3195c82551b527035d90bc6"
    decision: same-version
  - root: "event:session/title"
    previous: null
    after: "1b912703e2d64f91c99c675b8f805b01076c8325b905c1218ad81ef0b24909d5"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: null
    after: "17a54e266f84e876936358f2498ab5bb65b740a9f78a16c0aeb7f0171a5688dc"
    decision: same-version
  - root: "event:step/end"
    previous: null
    after: "e0a787e6ec76c7c94fecbc501b489164ab0293db05bc947914077ad01e674f05"
    decision: same-version
  - root: "event:step/start"
    previous: null
    after: "4513e088d43e6c68425be30451b9f961cc264fe7318ca62681c41d4d78615986"
    decision: same-version
  - root: "event:subagent/catalog"
    previous: null
    after: "ae1f7110feeec697b8cab42b68f7709aa7b3279764099dfb53c25890d2e5c871"
    decision: same-version
  - root: "event:subagent/descriptor"
    previous: null
    after: "b79ada42962cad0190a9d465805260567621fa3a4abd757eb31e6016b52d5ab5"
    decision: same-version
  - root: "event:subagent/model-selection-policy"
    previous: null
    after: "a6567ccb2e530606b775371eb4fa31468d72084339968e8b0440a516a23b39dc"
    decision: same-version
  - root: "event:system/message"
    previous: null
    after: "b9aff1009fba9d0daed3c4d5a61f8d1c0c828f5713523d0ed4ea2c7c278d7d47"
    decision: same-version
  - root: "event:team/member"
    previous: null
    after: "31d13edbb5fe2f8b7a38056320a8a06275ee4426e0abf12d4741818beda5a9c9"
    decision: same-version
  - root: "event:team/message/delivered"
    previous: null
    after: "c53bff743470c8bf11be698ced047072744ef088cce663a774b456d7a8982516"
    decision: same-version
  - root: "event:team/message/queued"
    previous: null
    after: "a6a26c92459c96e4f342e58d7e41c71956e7e62c9280e30e260df58409a3012c"
    decision: same-version
  - root: "event:team/task"
    previous: null
    after: "1688a2451eef9da19eaf45f12c8a27df07b1a6e56fa57ba603118f5201bb435b"
    decision: same-version
  - root: "event:todo/write"
    previous: null
    after: "b978cff734e62143eb56c9125423ec275405eda969802d42aaf73ecb987d3b26"
    decision: same-version
  - root: "event:tool-workflow/agent-end"
    previous: null
    after: "babf9ee4d1af62bf6c3a8103737f7a5e4e78ce179be835ce05a38803e15884b7"
    decision: same-version
  - root: "event:tool-workflow/agent-start"
    previous: null
    after: "5f26a6c20b37632f8f57729d171c671def4683d994ac6257a8dffcd855101627"
    decision: same-version
  - root: "event:tool-workflow/run-end"
    previous: null
    after: "42e0916e0dda5f6d1e7bb05d8514717147c036a79c9f36085683469516c1fd3f"
    decision: same-version
  - root: "event:tool-workflow/run-start"
    previous: null
    after: "c1f9e0405de6d18cabb9ee70782a027f9bbdc57e5abec9dcccdd56119e2e9058"
    decision: same-version
  - root: "event:tool/call"
    previous: null
    after: "3b1be838223869fe0a08210db85bf773796ed3f2373ac16555dff227cade0c48"
    decision: same-version
  - root: "event:tool/code-dispatch"
    previous: null
    after: "c14c2fdd439461cfc85105c6f620b0f62f799e3a69fb48196e938ec045aa0390"
    decision: same-version
  - root: "event:tool/code-dispatch-start"
    previous: null
    after: "9eb21c10fc675e1fa4184e5eecc9697aa87054ffd836d49428174897f0e64b62"
    decision: same-version
  - root: "event:tool/ptc-dispatch"
    previous: null
    after: "229c6735fde3b630dd043318ed63bbfe237a3c54cd2105bf8ae824e76b3e10ec"
    decision: same-version
  - root: "event:tool/ptc-dispatch-start"
    previous: null
    after: "ec38b5949af8eacaf00df002f4acbe344f934f8a061e9cdc65a52a48e5f6dd93"
    decision: same-version
  - root: "event:tool/result"
    previous: null
    after: "bc6e8c57a6b101b923d94eaf26676fc513e18fa9b895e5001c2bc0e7ffecc119"
    decision: same-version
  - root: "event:turn/end"
    previous: null
    after: "84c24f1209fc3e0153de6ac85d58fd6968b851f955e0e761b92321053956609e"
    decision: same-version
  - root: "event:turn/start"
    previous: null
    after: "aa0957eca50aeb28bcd2e6930b95809926edacb550c8c340ba526ba6b861b3d8"
    decision: same-version
  - root: "event:user/message"
    previous: null
    after: "2142dff39c0ef3817a843b34ab38015c27e4da35cda2fed3206edf4eb63f8217"
    decision: same-version
  - root: "event:userdoc/attached"
    previous: null
    after: "4e53f6719003dd537e20c4d02ea7a64c729a8e313536392fbaecf94e19e7de71"
    decision: same-version
  - root: "event:web/deepseek-search-llm-request"
    previous: null
    after: "cf6e3aaf1e2de6480aa0157730a41b9a492108a55304100b0f7e112711dd4331"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The baseline records the current schema without changing any reader or writer behavior. Committed Session generations remain governed by the existing format-version migration catalog. The fork's event vocabulary tracks its own lineage from this snapshot; compatibility claims apply to local generations, not to upstream release history.

<a id="verification"></a>
## Verification

verify-persistence-changes, verify-persistence-catalog, verify-persistence-formats, and verify-persistence-releases pass on the regenerated artifacts.

<a id="dev-note"></a>
## Dev Note

None.
