import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import { GenerationJobs } from '../generation/jobs.ts'
import type { IterationFeature } from '../host/agent.ts'
import { IterationJobs } from './jobs.ts'
import { IterationSessions } from './sessions.ts'

export async function startIterations(ctx: Context): Promise<void> {
  const lifetime = new AbortController()
  const home = join(resolveDshHome(), 'appstudio')
  const jobs = new IterationJobs(join(home, 'iterations'))
  const generation = new GenerationJobs(join(home, 'generation'))
  const sessions = new IterationSessions(ctx, (id) => generation.candidateFor(id) ?? jobs.candidateFor(id))
  const dispose = await sessions.initialize()
  ctx.effect(() => async () => {
    lifetime.abort()
    try {
      await Promise.allSettled([jobs.drain(), generation.drain()])
    } finally {
      await dispose()
    }
  })
  const feature: IterationFeature = { jobs, generation, sessions, signal: lifetime.signal }
  ctx.provide('appStudioIterations', feature)
}
