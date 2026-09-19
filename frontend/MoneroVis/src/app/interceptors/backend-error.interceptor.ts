import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { BackendStatusService } from '../service/backend-status.service';

export const backendErrorInterceptor: HttpInterceptorFn = (req, next) => {
  const backendStatusService = inject(BackendStatusService);

  return next(req).pipe(
    catchError((error: unknown) => {
      backendStatusService.markDown();
      return throwError(() => error);
    }),
  );
};
