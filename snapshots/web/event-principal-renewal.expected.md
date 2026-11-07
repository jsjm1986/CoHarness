# Managed event principal renewal

{
  "enabled": true,
  "eventSockets": 2,
  "initialHttpStatus": 200,
  "renewalBatches": 3,
  "batchSizes": [
    2,
    2,
    2
  ],
  "passedOriginalDeadline": true,
  "retainedAuthority": true,
  "oldHttpStatus": 401,
  "releasedOnSocketClose": true
}

{
  "enabled": false,
  "eventSockets": 2,
  "initialHttpStatus": 200,
  "renewalBatches": 0,
  "batchSizes": [],
  "passedOriginalDeadline": false,
  "retainedAuthority": false,
  "oldHttpStatus": null,
  "releasedOnSocketClose": false
}
