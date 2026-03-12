import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class ModalService {
  isOpen = signal(false);
  mode = signal<string | null>(null);
  data = signal<any>(null);

  open(mode: string, data: any = null) {
    this.mode.set(mode);
    this.data.set(data);
    this.isOpen.set(true);
  }

  close() {
    this.isOpen.set(false);
    this.mode.set(null);
    this.data.set(null);
  }
}
