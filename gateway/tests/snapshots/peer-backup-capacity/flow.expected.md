# Peer backup capacity

## Source allocation refused
status=507 code=peer-backup/source-capacity
privateFilesCopiedBeforeRefusal=2
sourceSession=unchanged sourceSchedule=unchanged privateStaging=empty

## A later backup succeeds
confirmed=true coveredFiles=2
privateStaging=empty

## Restored-payload validation allocation refused
resticRestore=verified managedFiles=verified
status=507 code=peer-backup/recovery-capacity
sourceSession=unchanged sourceSchedule=unchanged privateStaging=empty

## Offline recovery CLI
exit=1 stderr=peer-backup/recovery-capacity
privateRecovery=empty originalPoint=retained

## Foreground data remains usable
originalWriter=continued recoveryPoint=readable
schedule=unchanged
