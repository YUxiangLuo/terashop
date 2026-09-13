// Register immediately after acquiring a resource, before further setup can
// fail. Run in afterEach/afterAll or finally. One failed cleanup must not skip
// the others; failures remain visible rather than silently leaking fixtures.
export class Cleanup {
  private tasks: Array<() => Promise<unknown>> = [];

  defer(task: () => Promise<unknown>): void { this.tasks.push(task); }

  async run(): Promise<void> {
    const errors: unknown[] = [];
    while (this.tasks.length) {
      try { await this.tasks.pop()!(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed');
  }
}
