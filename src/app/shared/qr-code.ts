import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import qrcode from 'qrcode-generator';

/**
 * A QR code, rendered as one SVG path.
 *
 * Every dark module becomes a 1×1 square in a single `d` attribute and the
 * viewBox is the module grid itself, so the code is resolution-independent —
 * it stays razor sharp whether it's 180px on a phone or filling a laptop
 * screen, which matters because a camera has to read it off that screen.
 *
 * Bound through `[attr.d]` rather than innerHTML: no sanitizer in the path, no
 * markup built from user data.
 */
@Component({
  selector: 'app-qr-code',
  template: `
    <svg
      [attr.viewBox]="viewBox()"
      xmlns="http://www.w3.org/2000/svg"
      shape-rendering="crispEdges"
      role="img"
      [attr.aria-label]="label()"
    >
      <rect [attr.x]="-margin()" [attr.y]="-margin()" [attr.width]="span()" [attr.height]="span()" fill="#fff" />
      <path [attr.d]="path()" fill="#0c0d10" />
    </svg>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      svg {
        display: block;
        width: 100%;
        height: auto;
        border-radius: 10px;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QrCode {
  readonly data = input.required<string>();
  /** Quiet zone, in modules. The spec asks for 4; anything less hurts scanning. */
  readonly margin = input(4);
  readonly label = input('QR code');

  /** Error correction M — the usual balance of density against smudge/glare. */
  private readonly code = computed(() => {
    const qr = qrcode(0, 'M');
    qr.addData(this.data());
    qr.make();
    return qr;
  });

  private readonly count = computed(() => this.code().getModuleCount());
  protected readonly span = computed(() => this.count() + this.margin() * 2);
  protected readonly viewBox = computed(() => {
    const m = -this.margin();
    return `${m} ${m} ${this.span()} ${this.span()}`;
  });

  protected readonly path = computed(() => {
    const qr = this.code();
    const n = this.count();
    let d = '';
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return d;
  });
}
