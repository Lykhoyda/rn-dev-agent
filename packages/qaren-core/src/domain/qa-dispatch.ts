export type QaDispatchRefusal =
  | 'EVIDENCE_EXPIRED'
  | 'RUN_CANCELLED'
  | 'ACTION_CONTEXT_CHANGED'
  | 'ACTION_OUTCOME_UNCERTAIN';

export class QaDispatchError extends Error {
  constructor(readonly code: QaDispatchRefusal) {
    super(code);
    this.name = 'QaDispatchError';
  }
}

export class QaDispatchContext {
  private failure?: QaDispatchError;
  private sends = 0;

  constructor(
    readonly deadline: number,
    private readonly now: () => number,
    private readonly cancelled: () => boolean = () => false,
  ) {}

  get authorizations(): number {
    return this.sends;
  }

  get refusal(): QaDispatchError | undefined {
    return this.failure;
  }

  refuse(code: QaDispatchRefusal): never {
    this.failure ??= new QaDispatchError(code);
    throw this.failure;
  }

  check(): void {
    this.assertComplete();
    if (this.cancelled()) this.refuse('RUN_CANCELLED');
    const now = this.now();
    if (!Number.isFinite(now) || !Number.isFinite(this.deadline) || this.deadline < 0) {
      this.refuse('ACTION_CONTEXT_CHANGED');
    }
    if (now >= this.deadline) this.refuse('EVIDENCE_EXPIRED');
  }

  authorize(): void {
    this.check();
    this.sends++;
  }

  invalidate(): never {
    return this.refuse('ACTION_CONTEXT_CHANGED');
  }

  assertComplete(): void {
    if (this.failure) throw this.failure;
  }
}
