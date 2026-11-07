A signed healthy Runtime becomes ready and retains its resident reservation.
A signed response for another generation cannot acknowledge the requested Runtime.
A frozen wall clock cannot indefinitely retain startup or its resident reservation.
An in-flight readiness response uses the remaining startup budget and closes before release.
Resource registration completed after the readiness deadline cannot confirm startup.
Stopping during resource registration rejects startup as cancelled and joins physical termination.
A delayed ready publication cannot return successful startup after its deadline.
Resource-registration database refusal keeps its structured failure after physical rollback.
Ready-publication database refusal keeps its structured failure after physical rollback.
