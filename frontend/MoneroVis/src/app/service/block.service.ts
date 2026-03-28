import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { Block, BlocksResponse } from '../data/block';

const baseUrl = 'http://localhost:8080';

@Injectable({
  providedIn: 'root',
})
export class BlocksService {
  constructor(private http: HttpClient) {}

  getBlock(height: string): Observable<Block> {
    return this.http.get<Block>(`${baseUrl}/block/${height}`);
  }

  getBlocks(page: number): Observable<BlocksResponse> {
    return this.http.get<BlocksResponse>(`${baseUrl}/blocks?page=${page}`);
  }
}
