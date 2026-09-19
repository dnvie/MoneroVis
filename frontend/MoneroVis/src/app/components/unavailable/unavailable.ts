import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BackendStatusService } from '../../service/backend-status.service';

@Component({
  selector: 'app-unavailable',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './unavailable.html',
  styleUrl: './unavailable.scss',
})
export class Unavailable {
  private backendStatusService = inject(BackendStatusService);

  readonly isSpinning = signal(false);

  retry(): void {
    if (this.isSpinning()) return;

    this.isSpinning.set(true);
    setTimeout(() => this.isSpinning.set(false), 600);
    this.backendStatusService.checkConnection();
  }
}
