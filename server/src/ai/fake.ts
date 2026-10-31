import { AiError, type RsvpDraft, type RsvpInput, type RsvpModel } from './types.js';

/** Test stand-in for the model. Returns whatever draft you queue; records what it was asked. */
export class FakeRsvpModel implements RsvpModel {
  readonly inputs: RsvpInput[] = [];
  private queue: (RsvpDraft | AiError)[] = [];
  constructor(private fallback: RsvpDraft | null = null) {}
  willReturn(d: RsvpDraft): this { this.queue.push(d); return this; }
  willFail(e: AiError): this { this.queue.push(e); return this; }
  async extract(input: RsvpInput): Promise<RsvpDraft> {
    this.inputs.push(input);
    const next = this.queue.shift() ?? this.fallback;
    if (!next) throw new AiError('unavailable', 'fake: nothing queued');
    if (next instanceof AiError) throw next;
    return next;
  }
}
