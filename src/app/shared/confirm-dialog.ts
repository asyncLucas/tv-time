import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';

/**
 * A modal confirmation built on the native `<dialog>` element, so focus
 * trapping, Escape-to-dismiss and inert-ing the page behind it come from the
 * platform rather than hand-rolled listeners.
 *
 * Driven by an `open` input: the parent owns the pending action, the dialog
 * only reports what the user chose.
 */
@Component({
  selector: 'app-confirm-dialog',
  template: `
    <dialog #dlg (close)="onClose()" (click)="onBackdrop($event)">
      <div class="body">
        <h3>{{ heading() }}</h3>
        @if (message()) { <p>{{ message() }}</p> }
        <div class="actions">
          <button class="btn ghost" (click)="dismiss()">{{ cancelLabel() }}</button>
          <button class="btn" [class.primary]="!danger()" [class.danger]="danger()" (click)="accept()">
            {{ confirmLabel() }}
          </button>
        </div>
      </div>
    </dialog>
  `,
  styles: [
    `
      dialog {
        width: min(400px, calc(100vw - 32px));
        padding: 0;
        border: 1px solid var(--line);
        border-radius: var(--radius);
        background: var(--bg-elev);
        color: var(--text);
        box-shadow: var(--shadow-lg);
      }
      dialog::backdrop {
        background: rgba(6, 7, 9, 0.65);
        backdrop-filter: blur(2px);
      }
      .body {
        padding: 22px 22px 18px;
      }
      h3 {
        margin: 0;
        font-size: 16px;
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      p {
        margin: 8px 0 0;
        color: var(--text-dim);
        font-size: 13.5px;
        line-height: 1.5;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 20px;
      }
      .btn.danger {
        background: var(--bad);
        border-color: var(--bad);
        color: #2a0a0a;
      }
      .btn.danger:hover {
        filter: brightness(1.08);
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialog {
  readonly open = input(false);
  readonly heading = input('Are you sure?');
  readonly message = input('');
  readonly confirmLabel = input('Confirm');
  readonly cancelLabel = input('Cancel');
  /** Styles the confirm button as destructive (used for undoing progress). */
  readonly danger = input(false);

  readonly confirmed = output<void>();
  readonly dismissed = output<void>();

  private dlg = viewChild<ElementRef<HTMLDialogElement>>('dlg');

  /**
   * Closing via the confirm button also fires the element's `close` event —
   * this flag keeps that from reporting a dismissal on top of the confirmation.
   */
  private accepted = false;

  constructor() {
    effect(() => {
      const el = this.dlg()?.nativeElement;
      if (!el) return;
      if (this.open() && !el.open) {
        this.accepted = false;
        el.showModal();
      } else if (!this.open() && el.open) {
        el.close();
      }
    });
  }

  accept(): void {
    this.accepted = true;
    this.dlg()?.nativeElement.close();
    this.confirmed.emit();
  }

  dismiss(): void {
    this.dlg()?.nativeElement.close();
  }

  onClose(): void {
    if (!this.accepted) this.dismissed.emit();
  }

  /** A click that lands on the dialog element itself is a click on the backdrop. */
  onBackdrop(e: MouseEvent): void {
    if (e.target === this.dlg()?.nativeElement) this.dismiss();
  }
}
