import { cookies, type DangerouslyUnwrapCookies } from 'next/headers'

import { getSentinelValue } from '../../../getSentinelValue'
import { AllComponents } from '../commponents'

export default async function Page() {
  const allCookies = cookies() as unknown as DangerouslyUnwrapCookies
  return (
    <>
      <p>
        This page will exercise a number of APIs on the cookies() instance
        directly (without await it as a promise). It should not produce runtime
        errors but it will warn in dev
      </p>
      <AllComponents cookies={allCookies} expression="cookies()" />
      <div id="page">{getSentinelValue()}</div>
    </>
  )
}
