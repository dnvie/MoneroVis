import { Component, inject, HostListener, effect, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ModalService } from '../../service/modal.service';
import { ClipboardService } from '../../service/clipboard.service';

@Component({
  selector: 'app-modal',
  imports: [CommonModule, FormsModule],
  templateUrl: './modal.html',
  styleUrl: './modal.scss',
})
export class Modal {
  public modalService = inject(ModalService);
  public clipboardService = inject(ClipboardService);

  public labelText = signal('');
  public labelColor = signal('#e04f5f');

  public presetColors = [
    '#e04f5f',
    '#faa459',
    '#fccba0',
    '#f9e35e',
    '#59a14f',
    '#00bcd4',
    '#82b8ff',
    '#bf8bff',
    '#9e9e9e',
  ];

  public isCustomColor = signal(false);

  constructor() {
    effect(() => {
      if (this.modalService.mode() === 'edit-label') {
        const data = this.modalService.data();
        if (data) {
          this.labelText.set(data.currentText || '');
          const color = data.currentColor || '#e04f5f';
          this.labelColor.set(color);
          this.isCustomColor.set(!this.presetColors.includes(color));
        }
      }
    });

    effect(() => {
      const color = this.labelColor();
      if (!this.presetColors.includes(color)) {
        this.isCustomColor.set(true);
      } else {
        this.isCustomColor.set(false);
      }
    });
  }

  selectPreset(color: string) {
    this.labelColor.set(color);
    this.isCustomColor.set(false);
  }

  onCustomColorChange(color: string) {
    this.labelColor.set(color);
    this.isCustomColor.set(true);
  }

  @HostListener('document:keydown.escape')
  onEscKey() {
    if (this.modalService.isOpen()) {
      this.modalService.close();
    }
  }

  hasClipboardData(): boolean {
    return this.clipboardService.tabs().some((t) => t.items.length > 0);
  }

  saveLabel() {
    const data = this.modalService.data();
    if (data && data.onSave) {
      data.onSave(this.labelText(), this.labelColor());
    }
    this.modalService.close();
  }

  deleteLabel() {
    const data = this.modalService.data();
    if (data && data.onSave) {
      data.onSave('', '');
    }
    this.modalService.close();
  }

  selectExportFormat(format: 'gexf' | 'csv' | 'json') {
    const data = this.modalService.data();
    if (data && data.onSelect) {
      data.onSelect(format);
    }
    this.modalService.close();
  }

  getContrastColor(hex: string): string {
    if (!hex || hex.length < 7) return '#ffffff';
    const r = parseInt(hex.substr(1, 2), 16);
    const g = parseInt(hex.substr(3, 2), 16);
    const b = parseInt(hex.substr(5, 2), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 128 ? '#000000' : '#ffffff';
  }
}
