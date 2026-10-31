const lockName = (id: string) => `ratorder-recording:${id}`

// A browser-held lock disappears on tab termination, unlike a heartbeat timestamp.
export async function holdRecordingLock(id: string): Promise<() => void> {
  if (!navigator.locks) return () => {}
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await new Promise<void>((resolve, reject) => {
    void navigator.locks.request(lockName(id), async () => {
      resolve()
      await held
    }).catch(reject)
  })
  return release
}

export async function isRecordingActive(id: string): Promise<boolean> {
  if (!navigator.locks) return true
  try {
    const locks = await navigator.locks.query()
    return (locks.held ?? []).some((lock) => lock.name === lockName(id))
  } catch {
    // Do not declare a session interrupted when activity cannot be checked.
    return true
  }
}
