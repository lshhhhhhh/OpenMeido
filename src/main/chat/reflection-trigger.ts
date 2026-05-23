/**
 * Bump the persona-scoped reflection counter and fire the matching
 * reflection pass if the threshold was hit. Service owns both the
 * counter persistence and the threshold policy; chat just plumbs the
 * `wasToolTurn` signal.
 *
 * Fire-and-forget: the user's reply has already streamed, no point
 * making them wait for L3 extraction.
 */
export async function maybeTriggerReflection(
  memory: {
    bumpReflectionCounter(
      turnType: 'personal' | 'work' | 'neutral',
      force?: boolean,
    ): Promise<'personal' | null>
    reflectOnce(): Promise<number>
  },
  turnType: 'personal' | 'work' | 'neutral',
  forcePersonalReflection = false,
): Promise<void> {
  let triggered: 'personal' | null
  try {
    triggered = await memory.bumpReflectionCounter(turnType, forcePersonalReflection)
  } catch (err) {
    console.warn('[memory] bumpReflectionCounter failed:', err)
    return
  }
  if (triggered === 'personal' || forcePersonalReflection) {
    void memory
      .reflectOnce()
      .then((n) => {
        if (n > 0) console.log(`[memory] personal reflection upserted ${n} fact(s)`)
      })
      .catch((err) => console.warn('[memory] personal reflection threw:', err))
  }
}
