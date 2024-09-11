import { draftMode, type DangerouslyUnwrapDraftMode } from 'next/headers'

export async function GET(request: Request) {
  const syncDraftMode = draftMode() as unknown as DangerouslyUnwrapDraftMode
  const isEnabled = syncDraftMode.isEnabled
  if (isEnabled) {
    syncDraftMode.disable()
    return new Response('Draft mode is disabled')
  } else {
    syncDraftMode.enable()
    return new Response('Draft mode is enabled')
  }
}
