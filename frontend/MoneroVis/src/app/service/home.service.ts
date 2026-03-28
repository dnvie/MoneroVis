import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { HomeData } from '../data/home';

const baseUrl = 'http://localhost:8080';

@Injectable({
  providedIn: 'root',
})
export class HomeService {
  constructor(private http: HttpClient) {}

  getHomeData(): Observable<HomeData> {
    return this.http.get<HomeData>(`${baseUrl}/home`);
  }
}
