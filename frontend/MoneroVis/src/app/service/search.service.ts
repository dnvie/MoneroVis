import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { SearchResult } from '../data/search_result';

const baseUrl = 'http://localhost:8080';

@Injectable({
  providedIn: 'root',
})
export class SearchService {
  constructor(private http: HttpClient) {}

  search(query: string): Observable<SearchResult> {
    return this.http.get<SearchResult>(`${baseUrl}/search/${query}`);
  }
}
