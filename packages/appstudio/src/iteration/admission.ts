// Host and iteration services are bundled separately and must share the same error marker.
const admission = Symbol.for('dsh-plugin-appstudio.iteration-admission')

/** A request was rejected before its iteration was recorded. */
export class IterationAdmissionError extends Error {
  readonly [admission] = true

  static is(error: unknown): error is Error {
    return error instanceof Error && Reflect.get(error, admission) === true
  }
}
