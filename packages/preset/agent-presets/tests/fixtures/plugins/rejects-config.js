// A preset row whose config schema refuses the mounted value: the fiber
// settles into failure without apply() ever running, which only the mount
// audit's settle check can catch — the row has a fiber and satisfied injects.
export const name = 'rejects-config'
export const inject = []

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'fixture',
    validate(config) {
      return config?.token === 'expected'
        ? { value: config }
        : { issues: [{ message: 'token must be "expected"', path: ['token'] }] }
    },
  },
}

export function apply() {}
