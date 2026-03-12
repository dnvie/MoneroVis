import {
  Component,
  AfterViewInit,
  ElementRef,
  ChangeDetectionStrategy,
  signal,
  ChangeDetectorRef,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { Router, ActivatedRoute, NavigationEnd } from '@angular/router';
import { CommonModule } from '@angular/common';
import { BlocksService } from '../../service/block.service';
import { Block } from '../../data/block';
import { Subscription } from 'rxjs';
import * as d3 from 'd3';
import { Loader } from '../loader/loader';
import { filter } from 'rxjs/operators';
import { Title } from '@angular/platform-browser';

interface MoneroTransaction {
  name: string;
  size: number;
  fee: number;
  type: 'regular' | 'coinbase';
}

interface BlockData {
  name: 'Block';
  children: MoneroTransaction[];
}

@Component({
  selector: 'app-block',
  imports: [CommonModule, Loader],
  templateUrl: './block.component.html',
  styleUrl: './block.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BlockComponent implements AfterViewInit, OnDestroy, OnInit {
  blockHeight: string = '';

  private host!: d3.Selection<any, unknown, null, undefined>;
  private svg!: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private tooltip!: d3.Selection<HTMLDivElement, unknown, null, undefined>;
  private container!: d3.Selection<HTMLDivElement, unknown, null, undefined>;
  private width!: number;
  private height!: number;

  public block = signal<Block | null>(null);
  public isLoading = signal<boolean>(true);
  public error = signal<string | null>(null);
  public uniqueFees = signal<number[]>([]);
  public isGradientHovered = signal<boolean>(false);
  public hoveredFee = signal<number | null>(null);
  public hoveredTxHash = signal<string | null>(null);
  private lastHoveredFee: number | null = null;

  public displayLimit = signal<number>(50);

  private resizeObserver?: ResizeObserver;
  private routeSub?: Subscription;

  minFee: number = 0;
  maxFee: number = 0;

  constructor(
    private elRef: ElementRef,
    private router: Router,
    private route: ActivatedRoute,
    private service: BlocksService,
    private cdr: ChangeDetectorRef,
    private titleService: Title,
  ) {
    this.router.events
      .pipe(filter((rs): rs is NavigationEnd => rs instanceof NavigationEnd))
      .subscribe((event) => {
        if (event.id === 1 && event.url === event.urlAfterRedirects) {
          sessionStorage.clear();
        }
      });
  }

  increaseLimit() {
    this.displayLimit.set(this.block()?.transactions?.length || 10000);
  }

  ngOnInit(): void {
    this.isLoading.set(true);
  }

  ngAfterViewInit(): void {
    window.scrollTo(0, 0);
    this.host = d3.select(this.elRef.nativeElement);
    this.routeSub = this.route.params.subscribe((params) => {
      const newHeight = params['height'] || '';

      if (newHeight && (newHeight !== this.blockHeight || !this.blockHeight)) {
        this.blockHeight = newHeight;
        this.cleanupD3();
        this.fetchDataAndRender();
      }
    });
  }

  private cleanupD3(): void {
    if (this.svg) {
      this.svg.selectAll('*').remove();
    }
    if (this.tooltip) {
      this.tooltip.style('opacity', 0).html('');
    }
    this.resizeObserver?.disconnect();
  }

  private initializeD3Container(): boolean {
    this.container = this.host.select('#treeMap');
    this.tooltip = this.host.select('#tooltip');
    this.svg = this.host.select('#chart-svg');

    const containerNode = this.container.node() as HTMLElement;
    if (!containerNode) {
      return false;
    }

    this.width = containerNode.clientWidth;
    this.height = containerNode.clientHeight;

    this.tooltip.style('max-width', this.width + 'px');

    this.svg
      .attr('viewBox', `0 0 ${this.width} ${this.height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet');

    return true;
  }

  private fetchDataAndRender(): void {
    this.isLoading.set(true);
    this.error.set(null);
    this.resizeObserver?.disconnect();
    this.cdr.detectChanges();

    const requestedHeight = this.blockHeight;

    const cachedBlock = sessionStorage.getItem(requestedHeight);
    if (cachedBlock) {
      const block: Block = JSON.parse(cachedBlock);
      setTimeout(() => {
        if (this.blockHeight !== requestedHeight) return;
        this.processBlockData(block);
      });
    } else {
      this.service.getBlock(requestedHeight).subscribe({
        next: (block: Block) => {
          if (block && block.height) {
            sessionStorage.setItem(block.height.toString(), JSON.stringify(block));
          }

          setTimeout(() => {
            if (this.blockHeight !== requestedHeight) return;
            this.processBlockData(block);
          });
        },
        error: (err) => {
          if (this.blockHeight !== requestedHeight) return;

          console.error('Error fetching block data:', err);
          const errorMsg = `Failed to load block ${this.blockHeight}.`;
          this.error.set(errorMsg);
          this.isLoading.set(false);
          this.cdr.detectChanges();
          setTimeout(() => {
            const isD3Initialized = this.initializeD3Container();
            if (isD3Initialized) {
              this.svg
                .append('text')
                .attr('x', this.width / 2)
                .attr('y', this.height / 2)
                .attr('text-anchor', 'middle')
                .style('fill', 'white')
                .style('font-family', 'Google Sans Code, monospace')
                .style('font-size', '16px')
                .text(`Failed to load block ${this.blockHeight}.`);
            }
          }, 0);
        },
      });
    }
    this.titleService.setTitle('Block #' + this.blockHeight + ' · MoneroVis.com');
  }

  private processBlockData(block: Block): void {
    this.block.set(block);
    this.minFee = block.minFee;
    this.maxFee = block.maxFee;

    const fees = (block.transactions || []).map((tx) => tx.fee);
    const uniqueFeesSet = new Set(fees);
    this.uniqueFees.set(Array.from(uniqueFeesSet).sort((a, b) => a - b));

    this.isLoading.set(false);
    this.cdr.detectChanges();

    setTimeout(() => {
      if (this.blockHeight !== block.height.toString()) return;

      const treemapData = this.transformBlockData(block);
      const containerEl = this.elRef.nativeElement.querySelector('#treeMap');

      if (!containerEl) {
        console.error('TreeMap container not found *inside setTimeout*');
        return;
      }

      const isD3Initialized = this.initializeD3Container();
      if (isD3Initialized) {
        this.createTreemap(treemapData);
      }

      this.resizeObserver = new ResizeObserver((entries) => {
        if (!entries || entries.length === 0) return;
        const { width, height } = entries[0].contentRect;

        if (width > 0 && height > 0 && (width !== this.width || height !== this.height)) {
          this.width = width;
          this.height = height;

          requestAnimationFrame(() => {
            if (this.initializeD3Container()) {
              this.svg.selectAll('*').remove();
              this.createTreemap(treemapData);
            }
          });
        }
      });

      this.resizeObserver.observe(containerEl);
    }, 0);
  }

  private transformBlockData(block: Block): BlockData {
    const minerTx: MoneroTransaction | null = {
      name: block.minerTx.hash,
      size: block.minerTx.size,
      fee: 0,
      type: 'coinbase',
    };

    const regularTxs: MoneroTransaction[] = (block.transactions || []).map((tx) => ({
      name: tx.hash,
      size: tx.size,
      fee: tx.fee,
      type: 'regular',
    }));

    const blockData: BlockData = {
      name: 'Block',
      children: [minerTx, ...regularTxs],
    };

    return blockData;
  }

  private createTreemap(blockData: BlockData): void {
    const root = d3
      .hierarchy(blockData)
      .sum((d: any) => d.size)
      .sort((a, b) => (b.value || 0) - (a.value || 0));

    const treemapLayout = d3
      .treemap<BlockData>()
      .size([this.width, this.height])
      .tile(d3.treemapBinary)
      .padding(1);

    const treemapRoot = treemapLayout(root);

    const node = this.svg
      .selectAll('g')
      .data(treemapRoot.leaves())
      .join('g')
      .attr('class', 'node')
      .attr('transform', (d) => `translate(${d.x0}, ${d.y0})`)
      .on('click', (event, d) => this.handleNodeClick(event, d));

    node
      .append('rect')
      .attr('width', (d) => d.x1 - d.x0)
      .attr('height', (d) => d.y1 - d.y0)
      .attr('fill', (d) => this.getNodeColor(d))
      .attr('fill-opacity', 0.9)
      .on('mouseover', (event, d) => this.handleMouseOver(event, d))
      .on('mousemove', (event, d) => this.handleMouseMove(event, d))
      .on('mouseout', (event, d) => this.handleMouseOut(event, d));

    node
      .append('clipPath')
      .attr('id', (d, i) => `clip-id-${i}`)
      .append('rect')
      .attr('width', (d) => d.x1 - d.x0)
      .attr('height', (d) => d.y1 - d.y0);

    node
      .append('text')
      .attr('clip-path', (d, i) => `url(#clip-id-${i})`)
      .attr('x', 5)
      .attr('y', 16)
      .style('font-family', 'Google Sans Code, monospace')
      .style('font-size', '10px')
      .style('fill', (d: any) => (d.data.type === 'coinbase' ? '#333333' : '#ffffff'))
      .style('pointer-events', 'none')

      .text((d: any) => {
        const FONT_SIZE_PX = 10;
        const FONT_WIDTH_RATIO = 0.6;
        const CHAR_WIDTH = FONT_SIZE_PX * FONT_WIDTH_RATIO;
        const PADDING_X = 5;
        const rectWidth = d.x1 - d.x0;
        const availableWidth = rectWidth - PADDING_X;
        const fullText = d.data.name as string;
        const maxChars = Math.floor(availableWidth / CHAR_WIDTH);

        if (maxChars <= 1) {
          return '';
        }

        if (fullText.length <= maxChars) {
          return fullText;
        }

        if (maxChars <= 3) {
          return fullText.substring(0, maxChars);
        }

        return fullText.substring(0, maxChars - 2) + '..';
      })

      .style('display', (d) => {
        const height = d.y1 - d.y0;
        return height < 20 ? 'none' : 'inline';
      });
  }

  private getNodeColor(d: any): string {
    const coinbaseTxColor = '#FFFFFF';
    if (d.data.type === 'coinbase') {
      return coinbaseTxColor;
    }
    return this.getColorFromGradient((d.data.fee - this.minFee) / (this.maxFee - this.minFee));
  }

  private handleMouseOver(event: MouseEvent, d: any): void {
    const currentRect = d3.select(event.currentTarget as SVGRectElement);

    if (this.hoveredFee() === null && this.hoveredTxHash() === null) {
      currentRect
        .transition()
        .duration(0)
        .attr('fill', (d: any) => {
          const originalColor = this.getNodeColor(d);
          return d3.color(originalColor)?.darker(0.6).toString() ?? originalColor;
        });
    }

    this.tooltip.style('opacity', 1);
    let fee = d.data.type === 'coinbase' ? 'N/A (Coinbase)' : d.data.fee;

    this.tooltip.html(`
        <div class="tooltipHash">${d.data.name}</div>
        <div class="tooltipSize">Size: ${d.data.size.toFixed(4)} kB</div>
        <div class="tooltipFee">Fee: ${d.data.type === 'coinbase' ? '0' : fee}ɱ</div>
        <div class="tooltipType">Type: ${d.data.type === 'coinbase' ? 'Coinbase' : 'Transaction'}</div>
      `);
  }

  private handleMouseMove(event: MouseEvent, d: any): void {
    const containerNode = this.container.node();
    const tooltipNode = this.tooltip.node() as HTMLElement;

    if (!containerNode || !tooltipNode) return;

    const [mouseX, mouseY] = d3.pointer(event, containerNode);

    const tooltipWidth = tooltipNode.offsetWidth;
    const tooltipHeight = tooltipNode.offsetHeight;
    const containerWidth = this.width;
    const containerHeight = this.height;
    const offset = 15;

    let finalLeft: number;
    let finalTop: number;

    if (mouseX + offset + tooltipWidth > containerWidth) {
      finalLeft = mouseX - offset - tooltipWidth;

      if (finalLeft < 0) {
        finalLeft = 0;
      }
    } else {
      finalLeft = mouseX + offset;
    }

    if (mouseY + offset + tooltipHeight > containerHeight) {
      finalTop = mouseY - offset - tooltipHeight;

      if (finalTop < 0) {
        finalTop = 0;
      }
    } else {
      finalTop = mouseY + offset;
    }
    this.tooltip.style('left', finalLeft + 'px').style('top', finalTop + 'px');
  }

  private handleMouseOut(event: MouseEvent, d: any): void {
    const currentRect = d3.select(event.currentTarget as SVGRectElement);

    if (this.hoveredFee() === null && this.hoveredTxHash() === null) {
      currentRect
        .transition()
        .duration(100)
        .attr('fill', (d: any) => this.getNodeColor(d));
    }

    this.tooltip.style('opacity', 0);
  }

  private handleNodeClick(event: MouseEvent, d: any): void {
    if (d.data.type === 'regular' || d.data.type === 'coinbase') {
      this.navigateToTx(d.data.name);
    }
  }

  private getColorFromGradient(percentage: number): string {
    const startColor = '#FFBE9A';
    const endColor = '#DF560A';

    if (Number.isNaN(percentage)) {
      percentage = 0;
    }

    const clampedPercentage = Math.max(0, Math.min(1, percentage));
    const colorInterpolator = d3.interpolateRgb(startColor, endColor);
    const resultRgbString = colorInterpolator(clampedPercentage);
    const resultHex = d3.rgb(resultRgbString).formatHex().toUpperCase();

    return resultHex;
  }

  public calculateStepPosition(fee: number): string {
    const range = this.maxFee - this.minFee;

    if (range === 0) {
      return '50%';
    }

    const percentage = (fee - this.minFee) / range;

    const leftPercentage = percentage * 100;
    return `${leftPercentage}%`;
  }

  public onGradientEnter(): void {
    this.isGradientHovered.set(true);
  }

  public onGradientLeave(): void {
    this.isGradientHovered.set(false);
    this.hoveredFee.set(null);
    this.lastHoveredFee = null;
    if (this.hoveredTxHash() === null) {
      this.clearTxHighlight();
    }
  }

  public onGradientMove(event: MouseEvent): void {
    if (!this.isGradientHovered()) {
      this.isGradientHovered.set(true);
    }

    const fees = this.uniqueFees();
    if (fees.length === 0) return;

    const gradientBar = event.currentTarget as HTMLElement;
    const barWidth = gradientBar.clientWidth;
    const hoverX = event.offsetX;

    const hoverPercent = Math.max(0, Math.min(1, hoverX / barWidth));
    const range = this.maxFee - this.minFee;
    const targetFee = this.minFee + hoverPercent * range;

    const nearestFee = fees.reduce((prev, curr) => {
      return Math.abs(curr - targetFee) < Math.abs(prev - targetFee) ? curr : prev;
    });

    if (nearestFee !== this.lastHoveredFee) {
      this.lastHoveredFee = nearestFee;
      this.hoveredFee.set(nearestFee);
      this.hoveredTxHash.set(null);
      this.highlightTxsByFee(nearestFee);
    }
  }

  public hasPreviousBlock(b: Block): boolean {
    return b.height > 0;
  }

  public hasNextBlock(b: Block): boolean {
    return b.depth > 0;
  }

  public onTxEnter(hash: string): void {
    this.hoveredTxHash.set(hash);
    this.highlightTxByHash(hash);
  }

  public onTxLeave(): void {
    this.hoveredTxHash.set(null);
    if (this.hoveredFee() !== null) {
      this.highlightTxsByFee(this.hoveredFee()!);
    } else {
      this.clearTxHighlight();
    }
  }

  public highlightTxsByFee(fee: number): void {
    if (!this.svg) return;

    const highlightColor = '#df560a';
    const dimOpacity = 0.3;

    this.svg
      .selectAll('g.node rect')
      .transition()
      .duration(150)
      .attr('fill', (d: any) => {
        if (d.data.type === 'coinbase') {
          return this.getNodeColor(d);
        }
        if (d.data.fee === fee) {
          return highlightColor;
        }
        return this.getNodeColor(d);
      });

    this.svg
      .selectAll('g.node')
      .transition()
      .duration(150)
      .style('opacity', (d: any) => {
        if (d.data.type === 'coinbase') {
          return dimOpacity;
        }
        return d.data.fee === fee ? 1.0 : dimOpacity;
      });
  }

  public highlightTxByHash(hash: string): void {
    if (!this.svg) return;
    const dimOpacity = 0.3;

    this.svg
      .selectAll('g.node')
      .transition()
      .duration(150)
      .style('opacity', (d: any) => {
        return d.data.name === hash ? 1.0 : dimOpacity;
      });
  }

  public clearTxHighlight(): void {
    if (!this.svg) return;

    this.svg
      .selectAll('g.node rect')
      .transition()
      .duration(150)
      .attr('fill', (d: any) => this.getNodeColor(d));

    this.svg.selectAll('g.node').transition().duration(150).style('opacity', 1.0);
  }

  public navigateToBlock(height: number) {
    this.router.navigate(['/block/' + height]);
  }

  public navigateToBlocks() {
    this.router.navigate(['/blocks']);
  }

  public navigateToTx(hash: string) {
    this.router.navigate(['/tx/' + hash]);
  }

  public navigateToHome() {
    this.router.navigate(['/']);
  }

  public navigateToGlossary(input: string) {
    this.router.navigate(['/glossary'], { fragment: input });
  }

  getItemsArray(length: number): number[] {
    return Array.from({ length }, (_, index) => index + 1);
  }

  ngOnDestroy(): void {
    this.cleanupD3();
    this.routeSub?.unsubscribe();
  }
}
