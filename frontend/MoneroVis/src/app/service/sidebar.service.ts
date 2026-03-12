import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class SidebarService {
  isExpanded = signal(false);
  isAnyGraphFullscreen = signal(false);

  toggle() {
    this.isExpanded.update((v) => !v);
  }
}
