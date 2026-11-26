# Managed event principal renewal

{
  "enabled": true,
  "eventSockets": 2,
  "initialHttpStatus": 200,
  "renewalBatches": 4,
  "unavailableBatches": 1,
  "batchSizes": [
    2,
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
  "unavailableBatches": 0,
  "batchSizes": [],
  "passedOriginalDeadline": false,
  "retainedAuthority": false,
  "oldHttpStatus": null,
  "releasedOnSocketClose": false
}
