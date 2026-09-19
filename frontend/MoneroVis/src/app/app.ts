import { RouterOutlet } from '@angular/router';
import { SearchBar } from './components/search-bar/search-bar';
import { Component, inject, signal } from '@angular/core';
import { Router, NavigationEnd, Event } from '@angular/router';
import { filter } from 'rxjs/operators';
import { Sidebar } from './components/sidebar/sidebar';
import { Modal } from './components/modal/modal';
import { DecoyMap } from './components/decoy-map/decoy-map';
import { Footer } from './components/footer/footer';
import { Unavailable } from './components/unavailable/unavailable';
import { BackendStatusService } from './service/backend-status.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, SearchBar, Sidebar, Modal, DecoyMap, Footer, Unavailable],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private backendStatusService = inject(BackendStatusService);
  isBackendDown = this.backendStatusService.isBackendDown;

  protected readonly title = signal('MoneroVis');
  showSearchBar = signal(true);

  private hiddenRoutes = ['/decoymap'];

  constructor(private router: Router) {
    this.router.events
      .pipe(filter((event: Event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event: NavigationEnd) => {
        const currentUrl = event.urlAfterRedirects;
        const shouldHide = this.hiddenRoutes.some((route) => currentUrl.includes(route));
        this.showSearchBar.set(!shouldHide);
      });
  }
}
