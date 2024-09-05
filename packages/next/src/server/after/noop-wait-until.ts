export function noopWaitUntil(promise: Promise<any>) {
  promise.catch((err: unknown) => {
    console.error(err)
  })
}
