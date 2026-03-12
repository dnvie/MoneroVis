import {
  Component,
  signal,
  inject,
  OnInit,
  HostListener,
  viewChild,
  effect,
  computed,
} from '@angular/core';
import { Router, NavigationEnd, Event } from '@angular/router';
import { Clipboard } from '../clipboard/clipboard';
import { filter } from 'rxjs/operators';
import { TransactionGraph } from '../transaction-graph/transaction-graph';
import { MergingResult } from '../../data/merging_result';
import { Transaction } from '../../data/transaction';
import { ClipboardService } from '../../service/clipboard.service';
import { SidebarService } from '../../service/sidebar.service';
import { ModalService } from '../../service/modal.service';
import { DecoyService } from '../../service/decoy.service';

@Component({
  selector: 'app-sidebar',
  imports: [Clipboard, TransactionGraph],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
})
export class Sidebar implements OnInit {
  public sidebarService = inject(SidebarService);
  public modalService = inject(ModalService);
  public decoyService = inject(DecoyService);
  isExpanded = this.sidebarService.isExpanded;
  isGraphExpanded = signal(false);
  isOnDecoyMap = signal(false);
  isOnTransactionPage = signal(false);

  readonly transactionGraphRef = viewChild(TransactionGraph);

  hasTraceData = computed(() => !!this.clipboardService.automatedResults());

  showExternalExpandArrow = computed(
    () =>
      this.isOnDecoyMap() ||
      (!this.isExpanded() && this.isGraphExpanded()) ||
      (this.isOnTransactionPage() && this.sidebarService.isAnyGraphFullscreen()),
  );

  public clipboardService = inject(ClipboardService);
  private router = inject(Router);

  width = signal(600);
  isResizing = false;

  constructor() {
    this.router.events
      .pipe(filter((event: Event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event: NavigationEnd) => {
        const url = event.urlAfterRedirects;
        this.isOnDecoyMap.set(url.includes('/decoymap'));
        this.isOnTransactionPage.set(url.includes('/tx/'));

        if (url.includes('/tx/') && this.isGraphExpanded()) {
          this.isGraphExpanded.set(false);
        }
      });

    effect(() => {
      const mode = this.clipboardService.mode();
      if (mode === 'advanced' && this.isGraphExpanded()) {
        this.isGraphExpanded.set(false);
      }
    });
  }

  ngOnInit() {
    const savedWidth = localStorage.getItem('sidebar_width');
    if (savedWidth) {
      const parsedWidth = parseInt(savedWidth, 10);
      const minWidth = 400;
      const maxWidth = 1200;
      if (parsedWidth >= minWidth && parsedWidth <= maxWidth) {
        this.width.set(parsedWidth);
      }
    }
  }

  toggleDecoyMap() {
    if (this.decoyService.isOpen()) {
      this.decoyService.close();
    } else {
      this.decoyService.open();
    }
  }

  toggle() {
    this.sidebarService.toggle();
  }

  toggleGraph() {
    if (!this.isGraphExpanded()) {
      const results = this.clipboardService.automatedResults();
      const graph = this.transactionGraphRef();
      if (results && graph && graph.isEmpty()) {
        this.visualizeTrace(results);
      }
    }
    this.isGraphExpanded.update((v) => !v);
  }
  search(query: string) {
    if (!query) return;

    const num = Number(query);

    if (!isNaN(num) && Number.isInteger(num) && num > 0) {
      this.decoyService.openWithGlobalIndex(num);
      return;
    }
  }

  onResizeStart(event: MouseEvent) {
    this.isResizing = true;
    event.preventDefault();
  }

  @HostListener('document:mousemove', ['$event'])
  onResize(event: MouseEvent) {
    if (!this.isResizing) return;

    const newWidth = event.clientX;
    const minWidth = 400;
    const maxWidth = 1200;

    if (newWidth >= minWidth && newWidth <= maxWidth) {
      this.width.set(newWidth);
    }
  }

  @HostListener('document:mouseup')
  onResizeEnd() {
    if (this.isResizing) {
      this.isResizing = false;
      localStorage.setItem('sidebar_width', this.width().toString());
    }
  }

  private touchStartX = 0;

  onTouchStart(event: TouchEvent) {
    if (window.innerWidth > 550) return;
    this.touchStartX = event.changedTouches[0].clientX;
  }

  onTouchEnd(event: TouchEvent) {
    if (window.innerWidth > 550) return;
    const touchEndX = event.changedTouches[0].clientX;
    const deltaX = this.touchStartX - touchEndX;

    if (deltaX > 100 && this.isExpanded()) {
      this.sidebarService.toggle();
    }
  }

  public handleAutomatedTraceResult(event: {
    result: MergingResult;
    colors: string[];
  }) {
    if (!this.isGraphExpanded()) {
      this.isGraphExpanded.set(true);
    }

    setTimeout(() => {
      const graph = this.transactionGraphRef();
      if (graph) {
        this.visualizeTrace(event.result, event.colors);
      }
    }, 100);
  }

  public onDecoyMapNavigation() {
    //this.isGraphExpanded.set(false);
  }

  public onClearAutomatedTrace() {
    const graph = this.transactionGraphRef();
    if (graph) {
      graph.clearChart();
    }
    this.isGraphExpanded.set(false);
  }

  private visualizeTrace(result: MergingResult, colors?: string[]) {
    const transactionGraph = this.transactionGraphRef();
    if (!transactionGraph) return;

    transactionGraph.visualizeTrace(result, colors);
  }
}
