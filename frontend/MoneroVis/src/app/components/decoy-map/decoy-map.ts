import {
  Component,
  Input,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  NgZone,
  ChangeDetectorRef,
  signal,
  computed,
  inject,
  effect,
  HostListener,
  AfterViewInit,
} from '@angular/core';
import { forceCollide } from 'd3-force';
import { DecoyService } from '../../service/decoy.service';
import { DecoyTransactionResponse } from '../../data/decoy_transaction';
import { Subscription } from 'rxjs';
import { Router, ActivatedRoute, RouterLink, NavigationStart } from '@angular/router';
import { Loader } from '../loader/loader';
import { ClipboardService } from '../../service/clipboard.service';

declare var ForceGraph: any;

@Component({
  selector: 'app-decoy-map',
  templateUrl: './decoy-map.html',
  styleUrls: ['./decoy-map.scss'],
  imports: [Loader, RouterLink],
})
export class DecoyMap implements OnInit, OnDestroy, AfterViewInit {
  @ViewChild('graph', { static: true }) graphElementRef!: ElementRef;
  @ViewChild('dropdownContainer', { static: true }) dropdownContainerRef!: ElementRef<HTMLElement>;
  @ViewChild('selectedModeDisplay', { static: true })
  selectedModeDisplayRef!: ElementRef<HTMLElement>;
  @ViewChild('legendContainer', { static: true }) legendContainerRef!: ElementRef<HTMLElement>;

  @Input() decoyTransaction: DecoyTransactionResponse | null = null;
  public isLoading = signal(true);
  public graphFinishedLoading = signal(false);
  public error = signal<string | null>(null);
  public errorTooManyTxs = signal(false);
  public showLoader = computed(() => this.isLoading() || !this.graphFinishedLoading());
  public isOpen = computed(() => this.decoyService.isOpen());

  height = signal(typeof window !== 'undefined' ? window.innerHeight - 10 : 800);
  isResizing = false;

  private Graph: any;
  private canvas: HTMLCanvasElement | null = null;

  private currentIndex: number | null = null;

  private clipboardService = inject(ClipboardService);
  private suspiciousTxHashes = new Set<string>();

  public colors = {
    main: {
      tx: '#ffaa00',
      input: '#e09900',
      ring: '#c28500',
      linkInputRing: 'rgba(255, 170, 0, 0.6)',
      linkTxOutput: '#ffaa00',
    },
    child: {
      tx: '#E0E0E0',
      input: '#999999',
      ring: '#777777',
      defaultLink: 'rgba(150, 150, 150, 0.3)',
    },
    realSpend: {
      output: '#ec312c',
      link: 'rgba(236, 49, 44, 0.6)',
    },
    suspicious: {
      node: '#ff4081',
      link: 'rgba(255, 64, 129, 0.6)',
    },
    text: {
      tx: '#1f1f1f',
      default: '#fff',
    },
  };

  highlightMode = 'click';
  nodes: any[] = [];
  links: any[] = [];
  highlightNodes = new Set();
  highlightLinks = new Set();
  multiSelectNodes = new Set();
  trueSpendOutputId = '';
  showAllInputs = signal(false);
  lastHoveredNode: any = null;
  private hoverTimeout: any = null;
  private routerSubscription: Subscription | undefined;

  private boundHandleClick: (event: MouseEvent) => void;
  private boundHandleHover: (event: MouseEvent) => void;
  private boundHandleMouseLeave: () => void;
  private boundHandleKeyDown: (event: KeyboardEvent) => void;
  private boundHandleContextMenu: (event: MouseEvent) => void;
  private boundHandleWindowClick: (event: MouseEvent) => void;

  constructor(
    private ngZone: NgZone,
    public decoyService: DecoyService,
    private route: ActivatedRoute,
    private router: Router,
    private cdr: ChangeDetectorRef,
  ) {
    this.boundHandleClick = this.handleClick.bind(this);
    this.boundHandleHover = this.handleHover.bind(this);
    this.boundHandleMouseLeave = this.handleMouseLeave.bind(this);
    this.boundHandleKeyDown = this.handleKeyDown.bind(this);
    this.boundHandleContextMenu = this.handleContextMenu.bind(this);
    this.boundHandleWindowClick = this.handleWindowClick.bind(this);

    effect(() => {
      const params = this.decoyService.currentParams();
      if (!params) {
        this.decoyTransaction = null;
        this.initializeGraph();
        return;
      }

      this.showAllInputs.set(false);

      if (params.type === 'global_index') {
        this.currentIndex = params.index;
        this.loadDecoysFromGlobalIndex(params.index);
      } else if (params.type === 'tx_params') {
        this.currentIndex = params.index;
        this.loadDecoyTransaction(params.hash, params.key, params.index);
      }
    });

    effect(() => {
      const mode = this.clipboardService.mode();
      const simpleHashes = this.clipboardService.simpleModeHashes();
      const advancedHashes = this.clipboardService.allSuspiciousHashes();

      this.suspiciousTxHashes = mode === 'simple' ? simpleHashes : advancedHashes;

      if (this.Graph && this.nodes.length > 0) {
        this.updateNodeColors();
        this.forceRedraw();
      }
    });

    this.routerSubscription = this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        const maxHeight = window.innerHeight - 10;
        if (this.isOpen() && this.height() >= maxHeight - 5) {
          this.close();
        }
      }
    });
  }

  close() {
    this.decoyService.close();
  }

  closeAndClear() {
    this.decoyService.clear();
  }

  onResizeStart(event: MouseEvent) {
    if (window.innerWidth <= 550) return;
    this.isResizing = true;
    event.preventDefault();
  }

  @HostListener('window:resize')
  onWindowResize() {
    this.height.set(window.innerHeight - 10);
    this.updateGraphDimensions();
  }

  @HostListener('document:mousemove', ['$event'])
  onResize(event: MouseEvent) {
    if (!this.isResizing) return;

    const newHeight = window.innerHeight - event.clientY;
    const minHeight = 200;
    const maxHeight = window.innerHeight - 10;

    if (newHeight >= minHeight && newHeight <= maxHeight) {
      this.height.set(newHeight);
      this.updateGraphDimensions();
    }
  }

  private updateGraphDimensions() {
    if (this.Graph && this.graphElementRef && this.graphElementRef.nativeElement) {
      setTimeout(() => {
        const width = this.graphElementRef.nativeElement.clientWidth;
        const height = this.graphElementRef.nativeElement.clientHeight;
        this.Graph.width(width);
        this.Graph.height(height);
      }, 0);
    }
  }

  @HostListener('document:mouseup')
  onResizeEnd() {
    this.isResizing = false;
  }

  private touchStartY: number = 0;

  onOpenTouchStart(event: TouchEvent) {
    if (event.touches.length === 1) {
      this.touchStartY = event.touches[0].clientY;
    }
  }

  onOpenTouchEnd(event: TouchEvent) {
    if (event.changedTouches.length === 1) {
      const touchEndY = event.changedTouches[0].clientY;
      if (this.touchStartY - touchEndY > 30) {
        this.open();
      }
    }
  }

  onResizeTouchStart(event: TouchEvent) {
    if (window.innerWidth <= 550) return;
    if (event.touches.length === 1) {
      this.isResizing = true;
      this.touchStartY = event.touches[0].clientY;
    }
    event.preventDefault();
  }

  onResizeTouchMove(event: TouchEvent) {
    if (!this.isResizing || event.touches.length !== 1) return;
    event.preventDefault();

    const clientY = event.touches[0].clientY;
    const newHeight = window.innerHeight - clientY;

    if (newHeight > 50 && newHeight < window.innerHeight) {
      this.height.set(newHeight);
      this.updateGraphDimensions();
    }
  }

  onResizeTouchEnd(event: TouchEvent) {
    this.isResizing = false;
    if (event.changedTouches.length === 1) {
      const touchEndY = event.changedTouches[0].clientY;
      const movedDistance = touchEndY - this.touchStartY;
      const currentHeight = window.innerHeight - touchEndY;

      if (movedDistance > 100 || currentHeight < 200) {
        this.close();
      }
    }
  }

  open() {
    this.decoyService.open();
    setTimeout(() => {
      this.updateGraphDimensions();
    }, 50);
  }

  toggleInputDisplay() {
    this.isLoading.set(true);
    this.graphFinishedLoading.set(false);
    this.showAllInputs.update((v) => !v);

    setTimeout(() => {
      this.initializeGraph();
      this.isLoading.set(false);
    }, 10);
  }

  ngOnInit(): void {
    window.scrollTo(0, 0);

    const mode = this.clipboardService.mode();
    if (mode === 'simple') {
      this.suspiciousTxHashes = this.clipboardService.simpleModeHashes();
    } else {
      const suspiciousGroup = this.clipboardService
        .groupedItems()
        .find((g) => g.id === 'suspicious');
      if (suspiciousGroup) {
        this.suspiciousTxHashes = new Set(suspiciousGroup.items.map((item) => item.value));
      }
    }

    if (this.decoyTransaction) {
      this.isLoading.set(false);
    }
  }

  ngAfterViewInit() {
    const dropdownContainer = this.dropdownContainerRef.nativeElement;
    const selectedModeDisplay = this.selectedModeDisplayRef.nativeElement;
    const legendHeader = this.legendContainerRef.nativeElement.querySelector('strong');

    if (legendHeader) {
      legendHeader.addEventListener('click', () => {
        this.legendContainerRef.nativeElement.classList.toggle('collapsed');
      });
    }

    dropdownContainer.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).id === 'selected-mode') {
        dropdownContainer.classList.toggle('open');
      }
    });

    dropdownContainer.querySelectorAll('.mode-option').forEach((option) => {
      option.addEventListener('click', (event) => {
        const newMode = (event.target as HTMLElement).dataset['mode'] || 'click';
        this.highlightMode = newMode;
        const modeText = newMode.charAt(0).toUpperCase() + newMode.slice(1).replace('-c', '-C');
        selectedModeDisplay.textContent = `Mode: ${modeText}`;
        dropdownContainer.classList.remove('open');
        this.multiSelectNodes.clear();
        this.highlightNodes.clear();
        this.highlightLinks.clear();
        this.forceRedraw();
      });
    });
  }

  private updateNodeColors(): void {
    const mainTxId = this.decoyTransaction?.mainTransaction?.id;
    const mainTxInputIds = new Set(
      this.decoyTransaction?.mainTransaction?.inputs?.map((i: any) => i.id) || [],
    );

    this.nodes.forEach((node) => {
      if (node.type === 'tx') {
        const isSuspicious = this.suspiciousTxHashes.has(node.id);
        const isMain = node.id === mainTxId;

        if (isSuspicious) {
          node.color = this.colors.suspicious.node;
        } else {
          node.color = isMain ? this.colors.main.tx : this.colors.child.tx;
        }
      }
    });

    this.links.forEach((link) => {
      const source = typeof link.source === 'object' ? link.source.id : link.source;
      const target = typeof link.target === 'object' ? link.target.id : link.target;

      const isSuspicious = this.suspiciousTxHashes.has(source);

      if (isSuspicious) {
        link.color = this.colors.suspicious.link;
      } else {
        if (source === mainTxId) {
          const targetNode = this.nodes.find((n) => n.id === target);
          if (targetNode?.type === 'input') {
            link.color = this.colors.main.input;
          } else {
            link.color = this.colors.main.linkTxOutput;
          }
        } else {
          const sourceNode = this.nodes.find((n) => n.id === source);
          if (sourceNode?.type === 'input' && mainTxInputIds.has(source)) {
            link.color = this.colors.main.linkInputRing;
          } else {
            link.color = undefined;
          }
        }
      }
    });

    const nodeMap = new Map(this.nodes.map((node) => [node.id, node]));

    this.nodes.forEach((node) => {
      if (node.id === this.trueSpendOutputId) {
        node.color = this.colors.realSpend.output;
      }
    });

    this.links.forEach((link) => {
      const source = typeof link.source === 'object' ? link.source.id : link.source;
      const target = typeof link.target === 'object' ? link.target.id : link.target;
      if (source === this.trueSpendOutputId || target === this.trueSpendOutputId) {
        const inputNode = this.nodes.find(
          (n) => n.id === (source === this.trueSpendOutputId ? target : source),
        );
        if (inputNode?.type === 'input') {
          link.color = this.colors.realSpend.link;
        }
      }
    });

    this.updateDynamicLegend();
  }

  private loadDecoyTransaction(hash: string, key: string, index: number): void {
    this.isLoading.set(true);
    this.graphFinishedLoading.set(false);
    this.decoyTransaction = null;
    this.error.set(null);
    this.errorTooManyTxs.set(false);
    this.decoyService.getDecoys(hash, key, index).subscribe({
      next: (data: DecoyTransactionResponse) => {
        this.decoyTransaction = data;
        this.isLoading.set(false);
        this.initializeGraph();
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.log('Error fetching decoy map data', err);
        if (err.status === 400) {
          this.errorTooManyTxs.set(true);
        } else {
          this.error.set('Error loading data');
        }
        this.isLoading.set(false);
      },
    });
  }

  private loadDecoysFromGlobalIndex(index: number): void {
    this.isLoading.set(true);
    this.graphFinishedLoading.set(false);
    this.decoyTransaction = null;
    this.error.set(null);
    this.errorTooManyTxs.set(false);
    this.decoyService.getDecoysFromGlobalIndex(index).subscribe({
      next: (data: DecoyTransactionResponse) => {
        this.decoyTransaction = data;
        this.isLoading.set(false);
        this.initializeGraph();
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.log('Error fetching decoy map data from global index', err);
        if (err.status === 400) {
          this.errorTooManyTxs.set(true);
        } else {
          this.error.set('Error loading data');
        }
        this.isLoading.set(false);
      },
    });
  }

  ngOnDestroy(): void {
    if (this.routerSubscription) {
      this.routerSubscription.unsubscribe();
    }
    if (this.canvas) {
      this.canvas.removeEventListener('click', this.boundHandleClick);
      this.canvas.removeEventListener('mousemove', this.boundHandleHover);
      this.canvas.removeEventListener('mouseleave', this.boundHandleMouseLeave);
      this.canvas.removeEventListener('contextmenu', this.boundHandleContextMenu);
    }
    window.removeEventListener('keydown', this.boundHandleKeyDown);
    window.removeEventListener('click', this.boundHandleWindowClick);

    if (this.Graph && this.Graph._destructor) {
      this.Graph._destructor();
    }
  }

  private initializeGraph(): void {
    this.nodes = [];
    this.links = [];
    this.highlightNodes.clear();
    this.highlightLinks.clear();
    this.multiSelectNodes.clear();
    this.trueSpendOutputId = '';
    if (this.Graph) {
      if (this.Graph._destructor) {
        this.Graph._destructor();
      }
      this.Graph = null;
    }

    if (this.graphElementRef && this.graphElementRef.nativeElement) {
      this.graphElementRef.nativeElement.innerHTML = '';
    }

    this.processGraphData(this.decoyTransaction);
    this.updateDynamicLegend();

    const graphElement = this.graphElementRef.nativeElement;
    const dropdownContainer = this.dropdownContainerRef.nativeElement;

    this.Graph = ForceGraph()(graphElement)
      .graphData({ nodes: this.nodes, links: this.links })
      .nodeVal((n: any) => n.val)
      .nodeColor((n: any) => n.color)
      .linkColor((l: any) => l.color || this.colors.child.defaultLink)
      .linkWidth((l: any) => l.width || 1)
      .enableNodeDrag(false)
      .d3AlphaDecay(0.03)
      .d3AlphaMin(0.2)
      .warmupTicks(100)
      .onEngineStop(() => {
        this.ngZone.run(() => {
          this.graphFinishedLoading.set(true);
        });
      })
      .nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D) => {
        const isHighlighted = this.highlightNodes.has(node);
        if (this.highlightNodes.size > 0 && !isHighlighted) ctx.globalAlpha = 0.1;
        const x = node.x || 0,
          y = node.y || 0;
        const size = node.val * 5;
        const label = node.displayLabel || node.id;
        ctx.font = `6px "Google Sans Code"`;
        ctx.fillStyle = node.color;
        switch (node.type) {
          case 'tx': {
            const h = size / 2.5,
              w = h * 4.2,
              r = h / 3.25;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(x - w / 2, y - h / 2, w, h, r);
            else ctx.rect(x - w / 2, y - h / 2, w, h);
            ctx.fill();
            break;
          }
          case 'output': {
            const h = size * 1.5;
            ctx.beginPath();
            ctx.moveTo(x, y - h / 2);
            ctx.lineTo(x - h / 2, y + h / 2);
            ctx.lineTo(x + h / 2, y + h / 2);
            ctx.closePath();
            ctx.fill();
            break;
          }
          default: {
            ctx.beginPath();
            ctx.arc(x, y, size, 0, 2 * Math.PI);
            ctx.fill();
            break;
          }
        }
        if (node.type === 'tx') {
          ctx.font = `bold 6px "Google Sans Code"`;
          ctx.fillStyle = this.colors.text.tx;
        } else {
          ctx.fillStyle = this.colors.text.default;
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (node.type !== 'ring' || isHighlighted) {
          ctx.fillText(label, x, y + 0.5);
        }
        ctx.globalAlpha = 1;
      })
      .linkCanvasObject((link: any, ctx: CanvasRenderingContext2D) => {
        const isHighlighted = this.highlightLinks.has(link);
        if (this.highlightNodes.size > 0 && !isHighlighted) ctx.globalAlpha = 0.1;
        const start = link.source,
          end = link.target;
        if (!start || !end || isNaN(start.x) || isNaN(end.x)) return;
        const dx = end.x - start.x,
          dy = end.y - start.y;
        const mx = start.x + dx / 2 - dy * 0.2,
          my = start.y + dy / 2 + dx * 0.2;
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.quadraticCurveTo(mx, my, end.x, end.y);
        ctx.strokeStyle = link.color || this.colors.child.defaultLink;
        ctx.lineWidth = link.width || 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      });

    this.canvas = graphElement.querySelector('canvas');
    this.setupEventListeners();

    window.addEventListener('click', this.boundHandleWindowClick);

    this.Graph.d3Force('center', null);
    this.Graph.d3Force('link')
      .id((d: any) => d.id)
      .distance((d: any) => {
        if (d.source.type === 'input' && d.target.type === 'tx') return 35;
        if (d.source.type === 'tx' && d.target.type === 'output') return 35;
        if (d.source.type === 'ring' && d.target.type === 'input') return 70;
        return 50;
      })
      .strength((d: any) => {
        if (d.source.type === 'input' && d.target.type === 'tx') return 2.5;
        return 0.8;
      });
    this.Graph.d3Force('charge').strength(-150).distanceMin(1).distanceMax(2000);
    this.Graph.d3Force(
      'collide',
      forceCollide()
        .radius((n: any) => {
          const base = n.val * 6;
          const labelLength = n.type === 'ring' ? 0 : (n.displayLabel || n.id || '').length;
          const charWidth = 3.5;
          const labelRadius = (labelLength * charWidth) / 2;

          let typePadding = 0;
          switch (n.type) {
            case 'tx':
              typePadding = 20;
              break;
            case 'input':
              typePadding = 10;
              break;
            case 'output':
              typePadding = 12;
              break;
            case 'ring':
              typePadding = 8;
              break;
            default:
              typePadding = 8;
              break;
          }
          return Math.max(base, labelRadius) + typePadding;
        })
        .strength(0.9),
    );
  }

  public reloadGraph(): void {
    this.isLoading.set(true);
    this.graphFinishedLoading.set(false);

    const suspiciousGroup = this.clipboardService.groupedItems().find((g) => g.id === 'suspicious');
    if (suspiciousGroup) {
      this.suspiciousTxHashes = new Set(suspiciousGroup.items.map((item) => item.value));
    } else {
      this.suspiciousTxHashes.clear();
    }

    setTimeout(() => {
      this.initializeGraph();
      this.isLoading.set(false);
    }, 10);
  }

  public navigateToMainTx(): void {
    const mainTxId = this.decoyTransaction?.mainTransaction?.id;
    if (mainTxId) {
      this.router.navigate(['/tx', mainTxId]);
    } else {
      this.router.navigate(['/']);
    }
  }

  private formatId(id: string, startChars: number, endChars: number): string {
    if (id.length < startChars + endChars) return id;
    return `${id.substring(0, startChars)}...${id.substring(id.length - endChars)}`;
  }

  private processGraphData(data: any): void {
    if (!data) return;
    const addedNodeIds = new Set();
    const mainTx = data.mainTransaction;
    if (mainTx) {
      const isSuspicious = this.suspiciousTxHashes.has(mainTx.id);
      if (!addedNodeIds.has(mainTx.id)) {
        this.nodes.push({
          id: mainTx.id,
          type: 'tx',
          color: isSuspicious ? this.colors.suspicious.node : this.colors.main.tx,
          val: 6,
          displayLabel: this.formatId(mainTx.id, 4, 4),
        });
        addedNodeIds.add(mainTx.id);
      }

      if (mainTx.inputs) {
        mainTx.inputs.forEach((input: any) => {
          if (!addedNodeIds.has(input.id)) {
            this.nodes.push({
              id: input.id,
              type: 'input',
              color: this.colors.main.input,
              val: 1,
              displayLabel: this.formatId(input.id, 4, 4),
            });
            addedNodeIds.add(input.id);
          }
          this.links.push({
            source: mainTx.id,
            target: input.id,
            color: isSuspicious ? this.colors.suspicious.link : this.colors.main.input,
          });

          if (input.ringMembers) {
            input.ringMembers.forEach((ring: any) => {
              if (!addedNodeIds.has(ring.id)) {
                this.nodes.push({
                  id: ring.id,
                  type: 'ring',
                  color: this.colors.main.ring,
                  val: 0.25,
                  displayLabel: this.formatId(ring.id, 4, 4),
                });
                addedNodeIds.add(ring.id);
              }
              this.links.push({
                source: input.id,
                target: ring.id,
                color: this.colors.main.linkInputRing,
              });
            });
          }
        });
      }
    }

    if (data.childTransactions) {
      data.childTransactions.forEach((child: any) => {
        child.inputs.forEach((input: any) => {
          if (input.sourceRingMemberId) this.trueSpendOutputId = input.sourceRingMemberId;
        });
      });
    }
    if (mainTx) {
      const isSuspicious = this.suspiciousTxHashes.has(mainTx.id);
      mainTx.outputs.forEach((output: any) => {
        const isSpendOutput = output.id === this.trueSpendOutputId;
        const existingNode = this.nodes.find((n) => n.id === output.id);
        if (!existingNode) {
          this.nodes.push({
            id: output.id,
            type: 'output',
            color: isSpendOutput ? this.colors.realSpend.output : this.colors.main.tx,
            val: 3,
            displayLabel: this.formatId(output.id, 4, 4),
          });
          addedNodeIds.add(output.id);
        } else {
          existingNode.type = 'output';
          existingNode.val = 3;
          if (isSpendOutput) {
            existingNode.color = this.colors.realSpend.output;
          }
        }
        this.links.push({
          source: mainTx.id,
          target: output.id,
          color: isSuspicious ? this.colors.suspicious.link : this.colors.main.linkTxOutput,
          width: 2,
        });
      });
    }
    if (data.childTransactions) {
      data.childTransactions.forEach((childTx: any) => {
        const isChildSuspicious = this.suspiciousTxHashes.has(childTx.id);
        if (!addedNodeIds.has(childTx.id)) {
          this.nodes.push({
            id: childTx.id,
            type: 'tx',
            color: isChildSuspicious ? this.colors.suspicious.node : this.colors.child.tx,
            val: 5,
            displayLabel: this.formatId(childTx.id, 4, 4),
          });
          addedNodeIds.add(childTx.id);
        }
        childTx.inputs.forEach((input: any) => {
          if (!this.showAllInputs() && !input.sourceRingMemberId) {
            return;
          }

          if (!addedNodeIds.has(input.id)) {
            this.nodes.push({
              id: input.id,
              type: 'input',
              color: this.colors.child.input,
              val: 0.8,
              displayLabel: this.formatId(input.id, 4, 4),
            });
            addedNodeIds.add(input.id);
          }
          this.links.push({
            source: childTx.id,
            target: input.id,
            color: isChildSuspicious ? this.colors.suspicious.link : undefined,
          });
          if (input.sourceRingMemberId) {
            if (!addedNodeIds.has(input.sourceRingMemberId)) {
              const trueSpendRing = input.ringMembers.find((r: any) => r.isTrueSpend);
              if (trueSpendRing) {
                this.nodes.push({
                  id: trueSpendRing.id,
                  type: 'output',
                  color: this.colors.realSpend.output,
                  val: 3,
                  displayLabel: this.formatId(trueSpendRing.id, 4, 4),
                });
                addedNodeIds.add(trueSpendRing.id);
              }
            }
            this.links.push({
              source: input.sourceRingMemberId,
              target: input.id,
              color: this.colors.realSpend.link,
            });
          }
          input.ringMembers.forEach((ring: any) => {
            if (!ring.isTrueSpend) {
              if (!addedNodeIds.has(ring.id)) {
                this.nodes.push({
                  id: ring.id,
                  type: 'ring',
                  color: this.colors.child.ring,
                  val: 0.25,
                  displayLabel: this.formatId(ring.id, 4, 4),
                });
                addedNodeIds.add(ring.id);
              }
              this.links.push({
                source: input.id,
                target: ring.id,
                color: this.colors.child.defaultLink,
              });
            }
          });
        });
      });
    }
  }

  private getRelatedElements(selectedNode: any): { nodes: Set<any>; links: Set<any> } {
    const relatedNodes = new Set();
    const relatedLinks = new Set();
    if (!selectedNode) return { nodes: relatedNodes, links: relatedLinks };
    relatedNodes.add(selectedNode);
    switch (selectedNode.type) {
      case 'tx':
        this.links
          .filter((l) => l.source.id === selectedNode.id || l.target.id === selectedNode.id)
          .forEach((link) => {
            relatedLinks.add(link);
            relatedNodes.add(link.source);
            relatedNodes.add(link.target);
            if (link.target.type === 'input') {
              const inputNode = link.target;
              this.links
                .filter(
                  (l2) =>
                    (l2.source.id === inputNode.id || l2.target.id === inputNode.id) && l2 !== link,
                )
                .forEach((ringLink) => {
                  relatedLinks.add(ringLink);
                  relatedNodes.add(ringLink.source);
                  relatedNodes.add(ringLink.target);
                });
            }
          });
        break;
      case 'input':
        this.links
          .filter((l) => l.source.id === selectedNode.id || l.target.id === selectedNode.id)
          .forEach((link) => {
            relatedLinks.add(link);
            relatedNodes.add(link.source);
            relatedNodes.add(link.target);
          });
        break;
      case 'ring':
        this.links
          .filter((l) => l.source.id === selectedNode.id || l.target.id === selectedNode.id)
          .forEach((linkToInput) => {
            relatedLinks.add(linkToInput);
            const inputNode =
              linkToInput.source.id === selectedNode.id ? linkToInput.target : linkToInput.source;
            relatedNodes.add(inputNode);
            this.links
              .filter((l2) => l2.target.id === inputNode.id)
              .forEach((linkToTx) => {
                relatedLinks.add(linkToTx);
                relatedNodes.add(linkToTx.source);
              });
          });
        break;
      case 'output':
        this.links
          .filter((l) => l.source.id === selectedNode.id || l.target.id === selectedNode.id)
          .forEach((link) => {
            relatedLinks.add(link);
            relatedNodes.add(link.source);
            relatedNodes.add(link.target);
          });
        break;
    }
    return { nodes: relatedNodes, links: relatedLinks };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getNodeAt(x: number, y: number): any {
    if (!this.Graph) return null;
    const { x: graphX, y: graphY } = this.Graph.screen2GraphCoords(x, y);
    let closestNode = null;
    let minDistance = Infinity;
    const maxClickDistance = 15;
    for (const node of this.nodes) {
      const dist = Math.sqrt(Math.pow(node.x - graphX, 2) + Math.pow(node.y - graphY, 2));
      if (dist < minDistance) {
        minDistance = dist;
        closestNode = node;
      }
    }
    return minDistance <= maxClickDistance ? closestNode : null;
  }

  private forceRedraw(): void {
    if (!this.Graph) return;
    const currentTransform = this.Graph.zoom();
    this.Graph.zoom(currentTransform + 0.0001, 0);
    this.Graph.zoom(currentTransform, 0);
  }

  private handleContextMenu(event: MouseEvent): void {
    event.preventDefault();
    const clickedNode = this.getNodeAt(event.offsetX, event.offsetY);
    if (clickedNode && clickedNode.type === 'tx') {
      this.ngZone.run(() => {
        this.router.navigate(['/tx', clickedNode.id]);
        this.close();
      });
    }
  }

  private handleClick(event: MouseEvent): void {
    const clickedNode = this.getNodeAt(event.offsetX, event.offsetY);
    if (this.highlightMode === 'click') {
      this.highlightNodes.clear();
      this.highlightLinks.clear();
      this.multiSelectNodes.clear();
      if (clickedNode) {
        const { nodes, links } = this.getRelatedElements(clickedNode);
        nodes.forEach((n) => this.highlightNodes.add(n));
        links.forEach((l) => this.highlightLinks.add(l));
      }
    } else if (this.highlightMode === 'multi-click') {
      if (clickedNode) {
        if (this.multiSelectNodes.has(clickedNode)) this.multiSelectNodes.delete(clickedNode);
        else this.multiSelectNodes.add(clickedNode);
        this.highlightNodes.clear();
        this.highlightLinks.clear();
        this.multiSelectNodes.forEach((node) => {
          const { nodes, links } = this.getRelatedElements(node);
          nodes.forEach((n) => this.highlightNodes.add(n));
          links.forEach((l) => this.highlightLinks.add(l));
        });
      }
    }
    this.forceRedraw();
  }

  private handleHover(event: MouseEvent): void {
    const hoveredNode = this.getNodeAt(event.offsetX, event.offsetY);
    if (this.canvas) {
      this.canvas.style.cursor = hoveredNode ? 'pointer' : 'default';
    }
    if (this.highlightMode !== 'hover') return;
    if (hoveredNode) {
      if (this.hoverTimeout) {
        clearTimeout(this.hoverTimeout);
        this.hoverTimeout = null;
      }
      if (hoveredNode !== this.lastHoveredNode) {
        const { nodes, links } = this.getRelatedElements(hoveredNode);
        this.highlightNodes.clear();
        this.highlightLinks.clear();
        nodes.forEach((n) => this.highlightNodes.add(n));
        links.forEach((l) => this.highlightLinks.add(l));
        this.forceRedraw();
      }
    } else if (this.lastHoveredNode) {
      this.startHoverClearDelay();
    }
    this.lastHoveredNode = hoveredNode;
  }

  private handleMouseLeave(): void {
    if (this.highlightMode === 'hover' && this.lastHoveredNode) {
      this.startHoverClearDelay();
    }
  }

  private startHoverClearDelay(): void {
    if (this.hoverTimeout) {
      clearTimeout(this.hoverTimeout);
    }
    this.hoverTimeout = setTimeout(() => {
      this.highlightNodes.clear();
      this.highlightLinks.clear();
      this.forceRedraw();
      this.lastHoveredNode = null;
      this.hoverTimeout = null;
    }, 500);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.multiSelectNodes.clear();
      this.highlightNodes.clear();
      this.highlightLinks.clear();
      this.forceRedraw();
    }
  }

  private setupEventListeners(): void {
    if (!this.canvas) return;
    this.canvas.removeEventListener('click', this.boundHandleClick);
    this.canvas.removeEventListener('mousemove', this.boundHandleHover);
    this.canvas.removeEventListener('mouseleave', this.boundHandleMouseLeave);
    window.removeEventListener('keydown', this.boundHandleKeyDown);
    this.canvas.removeEventListener('contextmenu', this.boundHandleContextMenu);
    this.canvas.addEventListener('click', this.boundHandleClick);
    this.canvas.addEventListener('mousemove', this.boundHandleHover);
    this.canvas.addEventListener('mouseleave', this.boundHandleMouseLeave);
    this.canvas.addEventListener('contextmenu', this.boundHandleContextMenu);
    window.addEventListener('keydown', this.boundHandleKeyDown);
  }

  private handleWindowClick(e: MouseEvent) {
    if (!this.dropdownContainerRef.nativeElement.contains(e.target as Node)) {
      this.dropdownContainerRef.nativeElement.classList.remove('open');
    }
  }

  private updateDynamicLegend(): void {
    const foundKeys = new Set<string>();

    this.nodes.forEach((node) => {
      if (node.type === 'tx' && node.color === this.colors.suspicious.node)
        foundKeys.add('suspiciousTx');
      if (node.type === 'tx' && node.color === this.colors.main.tx) foundKeys.add('mainTx');
      if (node.type === 'output' && node.color === this.colors.main.tx) foundKeys.add('mainOutput');
      if (node.type === 'output' && node.color === this.colors.realSpend.output)
        foundKeys.add('realSpend');
      if (node.type === 'input' && node.color === this.colors.main.input)
        foundKeys.add('mainInput');
      if (node.type === 'ring' && node.color === this.colors.main.ring) foundKeys.add('mainRing');
      if (node.type === 'tx' && node.color === this.colors.child.tx) foundKeys.add('childTx');
      if (node.type === 'input' && node.color === this.colors.child.input)
        foundKeys.add('childInput');
      if (node.type === 'ring' && node.color === this.colors.child.ring) foundKeys.add('ring1');
    });

    let hasSpecialLinks = false;
    this.links.forEach((link) => {
      if (link.color === this.colors.realSpend.link) {
        foundKeys.add('realSpendLink');
        hasSpecialLinks = true;
      }
    });

    if (hasSpecialLinks) {
      foundKeys.add('edgesHeader');
    }

    this.legendContainerRef.nativeElement
      .querySelectorAll<HTMLElement>('[data-legend-key]')
      .forEach((item) => {
        const key = item.dataset['legendKey'];

        if (key && foundKeys.has(key)) {
          item.style.display = 'flex';
        } else {
          item.style.display = 'none';
        }
      });

    const mainHeader = this.legendContainerRef.nativeElement.querySelector('strong');
    if (mainHeader) {
      mainHeader.style.display = foundKeys.size > 0 ? 'block' : 'none';
    }
  }
}
