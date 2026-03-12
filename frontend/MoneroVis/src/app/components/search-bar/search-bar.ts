import {
  Component,
  ElementRef,
  ViewChild,
  HostListener,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { Router } from '@angular/router';
import { SearchService } from '../../service/search.service';
import { SearchResult, isBlock, isTransaction } from '../../data/search_result';
import { SidebarService } from '../../service/sidebar.service';

@Component({
  selector: 'app-search-bar',
  imports: [],
  templateUrl: './search-bar.html',
  styleUrl: './search-bar.scss',
})
export class SearchBar implements OnInit {
  @ViewChild('searchBar') searchBar!: ElementRef;
  searchInput: string = '';
  placeholderText = signal(this.getPlaceholder());
  isLoading = signal(false);
  private sidebarService = inject(SidebarService);

  constructor(
    private router: Router,
    private service: SearchService,
  ) {}

  ngOnInit() {
    const theme = localStorage.getItem('theme');
    if (theme) {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('theme', 'light');
    }
  }

  toggleSidebar() {
    this.sidebarService.toggle();
  }

  toggleTheme() {
    if (document.documentElement.getAttribute('data-theme') == 'dark') {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
    }
  }

  search(query: string) {
    if (!query) return;
    this.searchBar.nativeElement.blur();

    this.isLoading.set(true);
    this.service.search(query).subscribe({
      next: (data: SearchResult) => {
        this.isLoading.set(false);
        this.searchBar.nativeElement.value = '';
        if (isBlock(data)) {
          this.router.navigate(['/block', data.height]);
        } else if (isTransaction(data)) {
          this.router.navigate(['/tx', data.tx_hash]);
        }
      },
      error: (err) => {
        this.isLoading.set(false);
        console.error('Not found', err);

        const inputElement = this.searchBar.nativeElement;
        inputElement.classList.add('error');

        setTimeout(() => {
          inputElement.classList.remove('error');
        }, 1000);
      },
    });
  }

  @HostListener('window:resize')
  onResize() {
    this.placeholderText.set(this.getPlaceholder());
  }

  private getPlaceholder(): string {
    return window.innerWidth < 450
      ? 'Search for a Block or Tx'
      : 'Search for a Block Height/Hash or Transaction Hash';
  }
}
