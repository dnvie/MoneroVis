import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { Transaction, TransactionJson } from '../data/transaction';

const baseUrl = 'http://localhost:8080';

@Injectable({
  providedIn: 'root',
})
export class TransactionService {
  constructor(private http: HttpClient) {}

  getTransaction(hash: string): Observable<Transaction> {
    return this.http.get<Transaction>(`${baseUrl}/transaction/${hash}`);
  }

  getTransactionJson(hash: string): Observable<TransactionJson> {
    return this.http.get<TransactionJson>(`${baseUrl}/transactionJson/${hash}`);
  }

  getTransactions(hashes: string[]): Observable<Transaction[]> {
    return this.http.post<Transaction[]>(`${baseUrl}/transactions`, {
      hashes,
    });
  }
}
