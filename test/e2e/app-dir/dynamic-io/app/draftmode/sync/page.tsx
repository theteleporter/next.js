import { draftMode, type DangerouslyUnwrapDraftMode } from 'next/headers'

import { getSentinelValue } from '../../getSentinelValue'

import ToggleButton from './ToggleButton'

export default async function Page() {
  return (
    <>
      <p>
        This page uses `draftMode().isEnabled`. This is now a promise however
        reading it during prerender is fine becuase it is always false during
        prerender so we don't expect it to trigger any dynamic behavior.
      </p>
      <Component />
      <ToggleButton />
      <div id="page">{getSentinelValue()}</div>
    </>
  )
}

async function Component() {
  const syncDraftMode = draftMode() as unknown as DangerouslyUnwrapDraftMode
  return (
    <div>
      draftMode enabled?{' '}
      <span id="draft-mode">{'' + syncDraftMode.isEnabled}</span>
    </div>
  )
}
