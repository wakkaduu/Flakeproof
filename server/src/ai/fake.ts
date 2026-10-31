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

/** Test stand-in for the Judge model. */
import type { JudgeDraft, JudgeInput, JudgeModel } from './judge.js';
export class FakeJudgeModel implements JudgeModel {
  readonly inputs: JudgeInput[] = [];
  private queue: (JudgeDraft | AiError)[] = [];
  willReturn(d: JudgeDraft): this { this.queue.push(d); return this; }
  willFail(e: AiError): this { this.queue.push(e); return this; }
  async assess(input: JudgeInput): Promise<JudgeDraft> {
    this.inputs.push(input);
    const next = this.queue.shift();
    if (!next) throw new AiError('unavailable', 'fake judge: nothing queued');
    if (next instanceof AiError) throw next;
    return next;
  }
}

/** Test stand-in for the screenshot reader. Records the size of each image, never its bytes. */
import type { ScreenshotImage, ScreenshotModel, ShotDraft } from './transcribe.js';
export class FakeScreenshotModel implements ScreenshotModel {
  readonly inputs: { mimeType: string; bytes: number }[] = [];
  private queue: (ShotDraft | AiError)[] = [];
  willReturn(d: ShotDraft): this { this.queue.push(d); return this; }
  willFail(e: AiError): this { this.queue.push(e); return this; }
  async transcribe(image: ScreenshotImage): Promise<ShotDraft> {
    this.inputs.push({ mimeType: image.mimeType, bytes: Buffer.from(image.data, 'base64').length });
    const next = this.queue.shift();
    if (!next) throw new AiError('unavailable', 'fake screenshot reader: nothing queued');
    if (next instanceof AiError) throw next;
    return next;
  }
}
