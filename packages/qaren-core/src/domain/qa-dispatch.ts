export type QaDispatchRefusal =
  | 'EVIDENCE_EXPIRED'
  | 'RUN_CANCELLED'
  | 'ACTION_CONTEXT_CHANGED'
  | 'ACTION_OUTCOME_UNCERTAIN'
  | 'TARGET_MOVED_BEFORE_DISPATCH';

export class QaDispatchError extends Error {
  constructor(readonly code: QaDispatchRefusal) {
    super(code);
    this.name = 'QaDispatchError';
  }
}

export class QaDispatchContext {
  private failure?: QaDispatchError;
  private sends = 0;
  private attested = false;

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

  // The runner attested that the only authorized send changed nothing before refusing it.
  get refusedBeforeMutation(): boolean {
    return this.attested && this.sends === 1;
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

  invalidate(attestedNoMutation = false): never {
    if (!this.failure) this.attested = attestedNoMutation;
    return this.refuse('ACTION_CONTEXT_CHANGED');
  }

  assertComplete(): void {
    if (this.failure) throw this.failure;
  }
}
