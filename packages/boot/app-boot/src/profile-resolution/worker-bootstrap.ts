/** Install the inherited runtime resolution in one Harness-owned Worker. */

import { getEnvironmentData } from 'node:worker_threads'
import { installRuntimeInterception, type ProfileResolutionBehavior } from './resolver.ts'
import type { RuntimeResolution } from '../profile.ts'

const registration = getEnvironmentData(
  '@deepseek-ai/dsh-app-boot/profile-resolution',
) as {
  resolution: RuntimeResolution
  behavior?: ProfileResolutionBehavior
} | undefined
if (registration !== undefined) installRuntimeInterception(registration.resolution, registration.behavior)
