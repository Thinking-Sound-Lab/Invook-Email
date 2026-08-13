export async function runDailyGmailWatchRenewal<
  Watch extends { renewedAt: Date; expirationAt: Date },
  Catchup,
>(input: {
  renew: () => Promise<Watch>;
  catchUp: () => Promise<Catchup>;
  scheduleNext: (watch: Watch) => Promise<string>;
}): Promise<{ watch: Watch; catchup: Catchup; nextRenewalStepId: string }> {
  const watch = await input.renew();
  const catchup = await input.catchUp();
  const nextRenewalStepId = await input.scheduleNext(watch);
  return { watch, catchup, nextRenewalStepId };
}
