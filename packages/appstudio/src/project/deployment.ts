import { z } from 'zod'

export const deploymentFile = 'active-project.json'

const deployedProject = z.object({
  deploymentId: z.uuid(), activeRole: z.enum(['live', 'candidate']),
  projectRoot: z.string().max(4096).regex(/^[a-z]:[\\/]/iu),
  framework: z.enum(['flutter', 'react-native', 'android']),
  applicationId: z.string().max(255).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u),
  versionCode: z.string().regex(/^[1-9][0-9]{0,18}$/u), restored: z.boolean(),
})

export const deploymentRecord = z.object({ ownerId: z.uuid(), project: deployedProject })
export type DeploymentRecord = z.infer<typeof deploymentRecord>
