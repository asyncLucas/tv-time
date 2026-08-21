import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  afterNextRender,
  output,
  signal,
  viewChild,
  ElementRef,
} from '@angular/core';

/**
 * A live camera viewfinder that reports the first QR code it reads.
 *
 * Decoding takes the cheap path where the browser offers one — `BarcodeDetector`
 * is native, hardware-accelerated and costs nothing to ship — and lazily pulls a
 * pure-JS decoder in only when it's missing, which is still most of the web
 * (Safari, Firefox). The import is dynamic so that ~40 kB never lands in the
 * main bundle for the many people who open Settings and don't scan anything.
 *
 * The scan loop is a timer rather than requestAnimationFrame: reading a code
 * ten times a second is plenty, and a backgrounded tab shouldn't hold a camera
 * busy at display rate.
 */
@Component({
  selector: 'app-qr-scanner',
  template: `
    <div class="frame">
      <video #video playsinline muted [class.live]="live()"></video>
      <div class="reticle" aria-hidden="true"></div>
      @if (!live()) {
        <div class="pending">{{ error() ?? 'Starting camera…' }}</div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .frame {
        position: relative;
        aspect-ratio: 1;
        width: 100%;
        max-width: 280px;
        border-radius: 16px;
        overflow: hidden;
        background: #000;
        border: 1px solid var(--line);
      }
      video {
        width: 100%;
        height: 100%;
        object-fit: cover;
        opacity: 0;
        transition: opacity 0.25s ease;
      }
      video.live {
        opacity: 1;
      }
      .reticle {
        position: absolute;
        inset: 16%;
        border-radius: 12px;
        box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.35);
        border: 2px solid var(--gold);
      }
      .pending {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 20px;
        text-align: center;
        color: var(--text-dim);
        font-size: 12.5px;
        line-height: 1.5;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QrScanner implements OnDestroy {
  /** The decoded text of the first code seen; the camera stops right after. */
  readonly scanned = output<string>();
  /** Camera unavailable or refused — the caller falls back to pasting a code. */
  readonly failed = output<string>();

  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  protected readonly live = signal(false);
  protected readonly error = signal<string | null>(null);

  private stream?: MediaStream;
  private timer?: ReturnType<typeof setTimeout>;
  private canvas?: HTMLCanvasElement;
  private detector?: { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> };
  private jsQR?: typeof import('jsqr').default;
  private stopped = false;

  constructor() {
    afterNextRender(() => void this.start());
  }

  private async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      return this.giveUp('This browser has no camera access. Paste the code instead.');
    }
    try {
      // `environment` is a hint, not a demand — a laptop with only a front
      // camera still satisfies it, which is what we want on a desktop.
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
    } catch (e) {
      const denied = (e as DOMException)?.name === 'NotAllowedError';
      return this.giveUp(
        denied
          ? 'Camera access was blocked. Allow it in your browser, or paste the code instead.'
          : 'No camera available. Paste the code instead.',
      );
    }
    if (this.stopped) return this.release();

    const el = this.video().nativeElement;
    el.srcObject = this.stream;
    await el.play().catch(() => undefined);
    this.live.set(true);

    const Detector = (window as any).BarcodeDetector;
    if (Detector) {
      try {
        this.detector = new Detector({ formats: ['qr_code'] });
      } catch {
        this.detector = undefined;
      }
    }
    if (!this.detector) this.jsQR = (await import('jsqr')).default;

    this.tick();
  }

  private tick = (): void => {
    if (this.stopped) return;
    void this.read().then((text) => {
      if (this.stopped) return;
      if (text) {
        this.stop();
        this.scanned.emit(text);
      } else {
        this.timer = setTimeout(this.tick, 100);
      }
    });
  };

  private async read(): Promise<string | null> {
    const el = this.video().nativeElement;
    if (!el.videoWidth) return null;
    try {
      if (this.detector) {
        const [hit] = await this.detector.detect(el);
        return hit?.rawValue ?? null;
      }
      // The fallback wants pixels, so the frame goes through a canvas. Half
      // resolution is still far more than a QR code needs and quarters the work.
      const w = Math.round(el.videoWidth / 2);
      const h = Math.round(el.videoHeight / 2);
      const canvas = (this.canvas ??= document.createElement('canvas'));
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx || !this.jsQR) return null;
      ctx.drawImage(el, 0, 0, w, h);
      return this.jsQR(ctx.getImageData(0, 0, w, h).data, w, h)?.data ?? null;
    } catch {
      return null;
    }
  }

  private giveUp(message: string): void {
    this.error.set(message);
    this.failed.emit(message);
  }

  /** Stop decoding and hand the camera back — the light must go out. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.release();
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.live.set(false);
  }

  ngOnDestroy(): void {
    this.stop();
  }
}
