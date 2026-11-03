Missing runtime accounts are reported before credential creation or process allocation.
Native control clients exclude Gateway database variables and disable prompts.
Generation credentials survive startup and remain private until the supervisor confirms stopped.
Cancellation closes the daemon-reload client before startup settles.
Cancellation closes the restart client and retains the generation cleanup handle.
Cancellation force-kills an uncooperative native client before startup settles.
A stalled liveness client times out without proving unit exit.
A stalled stop client times out without releasing service ownership.
