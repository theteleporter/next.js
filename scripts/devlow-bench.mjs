import { rm, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe } from '@vercel/devlow-bench'
import { measureTime, reportMeasurement } from '@vercel/devlow-bench'
import { newBrowserSession } from '@vercel/devlow-bench/browser'
import { command } from '@vercel/devlow-bench/shell'
import { waitForFile } from '@vercel/devlow-bench/file'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

const nextDevWorkflow =
  (benchmarkName, pages) =>
  async ({ turbopack, page }) => {
    const pageConfig =
      typeof pages[page] === 'string' ? { url: pages[page] } : pages[page]
    const cleanupTasks = []
    try {
      const benchmarkDir = resolve(REPO_ROOT, 'bench', benchmarkName)

      // cleanup .next directory to remove persistent cache
      await retry(() =>
        rm(join(benchmarkDir, '.next'), { recursive: true, force: true })
      )

      await measureTime('cleanup', {
        scenario: benchmarkName,
        props: { turbopack: null, page: null },
      })

      // startup browser
      let session = await newBrowserSession({})
      const closeSession = async () => {
        if (session) {
          await session.close()
          session = null
        }
      }
      cleanupTasks.push(closeSession)
      await measureTime('browser startup', {
        props: { turbopack: null, page: null },
      })

      const env = {
        PATH: process.env.PATH,
        NODE: process.env.NODE,
        HOSTNAME: process.env.HOSTNAME,
        PWD: process.env.PWD,
        NODE_ENV: 'development',
        // Disable otel initialization to prevent pending / hanging request to otel collector
        OTEL_SDK_DISABLED: 'true',
        NEXT_PUBLIC_OTEL_SENTRY: 'true',
        NEXT_PUBLIC_OTEL_DEV_DISABLED: 'true',
        NEXT_TRACE_UPLOAD_DISABLED: 'true',
        // Enable next.js test mode to get HMR events
        __NEXT_TEST_MODE: '1',
      }

      // run command to start dev server
      const args = [turbopack ? 'dev-turbopack' : 'dev-webpack']
      let shell = command('pnpm', args, {
        cwd: benchmarkDir,
        env,
      })
      const killShell = async () => {
        if (shell) {
          await shell.kill()
          shell = null
        }
      }
      cleanupTasks.push(killShell)

      // wait for server to be ready
      const START_SERVER_REGEXP = /Local:\s+(?<url>.+)\n/
      const {
        groups: { url },
      } = await shell.waitForOutput(START_SERVER_REGEXP)
      await measureTime('server startup', { props: { page: null } })
      await shell.reportMemUsage('mem usage after startup', {
        props: { page: null },
      })

      // open page
      const pageInstance = await session.hardNavigation(
        'open page',
        url + pageConfig.url
      )
      await shell.reportMemUsage('mem usage after open page')

      let status = 0
      try {
        if (
          await pageInstance.evaluate(
            '!next.appDir && __NEXT_DATA__.page === "/404"'
          )
        ) {
          status = 2
        }
      } catch (e) {
        status = 2
      }

      try {
        if (
          !(await pageInstance.evaluate(
            'next.appDir || __NEXT_DATA__.page && !__NEXT_DATA__.err'
          ))
        ) {
          status = 1
        }
      } catch (e) {
        status = 1
      }

      await reportMeasurement('page status', status, 'status code')

      // reload page
      await session.reload('reload page')

      await reportMeasurement(
        'console output',
        shell.output.split(/\n/).length,
        'lines'
      )

      // HMR
      if (pageConfig.hmr) {
        let hmrEvent = () => {}
        pageInstance.exposeBinding(
          'TURBOPACK_HMR_EVENT',
          (_source, latency) => {
            hmrEvent(latency)
          }
        )
        const { file, before, after } = pageConfig.hmr
        const path = resolve(benchmarkDir, file)
        const content = await readFile(path, 'utf8')
        cleanupTasks.push(async () => {
          await writeFile(path, content, 'utf8')
        })
        let currentContent = content
        /* eslint-disable no-await-in-loop */
        for (let hmrAttempt = 0; hmrAttempt < 10; hmrAttempt++) {
          if (hmrAttempt > 0) {
            await new Promise((resolve) => {
              setTimeout(resolve, 1000)
            })
          }
          const linesStart = shell.output.split(/\n/).length
          let reportedName
          if (hmrAttempt < 3) {
            reportedName = 'hmr/warmup'
          } else {
            reportedName = 'hmr'
          }
          await pageInstance.evaluate(
            'window.__NEXT_HMR_CB = (arg) => TURBOPACK_HMR_EVENT(arg); window.__NEXT_HMR_LATENCY_CB = (arg) => TURBOPACK_HMR_EVENT(arg);'
          )
          // eslint-disable-next-line no-loop-func
          const hmrDone = new Promise((resolve) => {
            let once = true
            const end = async (code) => {
              const success = code <= 1
              if (!success && !reportedName) reportedName = 'hmr'
              if (reportedName) {
                await reportMeasurement(
                  `${reportedName}/status`,
                  code,
                  'status code'
                )
              }
              clearTimeout(timeout)
              resolve(success)
            }
            cleanupTasks.push(async () => {
              if (!once) return
              once = false
              await end(3)
            })
            const timeout = setTimeout(async () => {
              if (!once) return
              once = false
              await end(2)
            }, 60000)
            hmrEvent = async (latency) => {
              if (!once) return
              once = false
              if (reportedName) {
                if (typeof latency === 'number') {
                  await reportMeasurement(
                    `${reportedName}/reported latency`,
                    latency,
                    'ms'
                  )
                }
                await measureTime(reportedName, {
                  relativeTo: `${reportedName}/start`,
                })
              }
              await end(0)
            }
            pageInstance.once('load', async () => {
              if (!once) return
              once = false
              if (reportedName) {
                await measureTime(reportedName, {
                  relativeTo: `${reportedName}/start`,
                })
              }
              await end(1)
            })
          })
          const idx = before
            ? currentContent.indexOf(before)
            : currentContent.indexOf(after) + after.length

          let newContent = `${currentContent}\n\n/* HMR */`
          if (file.endsWith('.tsx')) {
            newContent = `${currentContent.slice(
              0,
              idx
            )}<div id="hmr-test">HMR</div>${currentContent.slice(idx)}`
          } else if (file.endsWith('.css')) {
            newContent = `${currentContent.slice(
              0,
              idx
            )}\n--hmr-test-${hmrAttempt}: 0;\n${currentContent.slice(idx)}`
          } else if (file.endsWith('.mdx')) {
            newContent = `${currentContent.slice(
              0,
              idx
            )}\n\nHMR\n\n${currentContent.slice(idx)}`
          }

          if (reportedName) {
            await measureTime(`${reportedName}/start`)
          }

          if (currentContent === newContent) {
            throw new Error("HMR didn't change content")
          }
          await writeFile(path, newContent, 'utf8')
          currentContent = newContent
          const success = await hmrDone

          if (reportedName) {
            await reportMeasurement(
              `console output/${reportedName}`,
              shell.output.split(/\n/).length - linesStart,
              'lines'
            )
          }

          if (!success) break
        }
        /* eslint-enable no-await-in-loop */
      }

      if (turbopack) {
        // close dev server and browser
        await killShell()
        await closeSession()
      } else {
        // wait for persistent cache to be written
        const waitPromise = new Promise((resolve) => {
          setTimeout(resolve, 5000)
        })
        const cacheLocation = join(
          benchmarkDir,
          '.next',
          'cache',
          'webpack',
          'client-development'
        )
        await Promise.race([
          waitForFile(join(cacheLocation, 'index.pack')),
          waitForFile(join(cacheLocation, 'index.pack.gz')),
        ])
        await measureTime('cache created')
        await waitPromise
        await measureTime('waiting')

        // close dev server and browser
        await killShell()
        await closeSession()
      }

      // startup new browser
      session = await newBrowserSession({})
      await measureTime('browser startup', {
        props: { turbopack: null, page: null },
      })

      // run command to start dev server
      shell = command('pnpm', args, {
        cwd: benchmarkDir,
        env,
      })

      // wait for server to be ready
      const {
        groups: { url: url2 },
      } = await shell.waitForOutput(START_SERVER_REGEXP)
      await shell.reportMemUsage('mem usage after startup with cache')

      // open page
      await session.hardNavigation(
        'open page with cache',
        url2 + pageConfig.url
      )

      await reportMeasurement(
        'console output with cache',
        shell.output.split(/\n/).length,
        'lines'
      )
      await shell.reportMemUsage('mem usage after open page with cache')
    } catch (e) {
      console.log('CAUGHT', e)
      throw e
    } finally {
      // This must run in order
      // eslint-disable-next-line no-await-in-loop
      for (const task of cleanupTasks.reverse()) await task()
      await measureTime('shutdown')
    }
  }

const pages = {
  homepage: {
    url: '/',
    hmr: {
      file: 'components/lodash.js',
      before: '<h1>Client Component</h1>',
    },
  },
}

describe(
  'heavy-npm-deps dev test',
  {
    turbopack: true,
    page: Object.keys(pages),
  },
  nextDevWorkflow('heavy-npm-deps', pages)
)

async function retry(fn) {
  let lastError
  for (let i = 100; i < 2000; i += 100) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn()
      return
    } catch (e) {
      lastError = e
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, i)
      })
    }
  }
  throw lastError
}