import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { DecoyTransactionResponse } from '../data/decoy_transaction';

const baseUrl = 'http://localhost:8081';

export type DecoyMapParams =
  | { type: 'global_index'; index: number }
  | { type: 'tx_params'; hash: string; key: string; index: number }
  | null;

@Injectable({
  providedIn: 'root',
})
export class DecoyService {
  constructor(private http: HttpClient) {}

  isOpen = signal(false);
  currentParams = signal<DecoyMapParams>(null);

  open() {
    this.isOpen.set(true);
  }

  openWithGlobalIndex(index: number) {
    this.currentParams.set({ type: 'global_index', index });
    this.isOpen.set(true);
  }

  openWithTxParams(hash: string, key: string, index: number) {
    this.currentParams.set({ type: 'tx_params', hash, key, index });
    this.isOpen.set(true);
  }

  close() {
    this.isOpen.set(false);
  }

  clear() {
    this.isOpen.set(false);
    this.currentParams.set(null);
  }

  getDecoys(hash: string, key: string, index: number): Observable<DecoyTransactionResponse> {
    const params = new HttpParams()
      .set('tx_hash', hash)
      .set('key', key)
      .set('global_output_index', index);

    return this.http.get<DecoyTransactionResponse>(`${baseUrl}/decoys`, {
      params,
    });
  }

  getDecoysFromGlobalIndex(index: number): Observable<DecoyTransactionResponse> {
    const params = new HttpParams().set('global_output_index', index.toString());

    return this.http.get<DecoyTransactionResponse>(`${baseUrl}/decoysByIndex`, {
      params,
    });
  }
}
