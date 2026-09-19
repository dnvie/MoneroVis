import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { timeout, catchError } from 'rxjs/operators';
import { of } from 'rxjs';

const baseUrl = 'http://localhost:8080';

@Injectable({
  providedIn: 'root',
})
export class BackendStatusService {
  private http = inject(HttpClient);

  readonly isBackendDown = signal<boolean>(false);
  private isChecking = false;

  markDown(): void {
    this.isBackendDown.set(true);
  }

  markUp(): void {
    this.isBackendDown.set(false);
  }

  checkConnection(): void {
    if (this.isChecking) return;
    this.isChecking = true;

    this.http
      .get(`${baseUrl}/home`, { responseType: 'json' })
      .pipe(
        timeout(10000),
        catchError(() => of(null)),
      )
      .subscribe((res) => {
        this.isChecking = false;
        if (res !== null) {
          this.markUp();
          window.location.href = '/';
        }
      });
  }
}
