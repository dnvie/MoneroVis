import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  Input,
  Output,
  EventEmitter,
  OnChanges,
  SimpleChanges,
} from '@angular/core';
import * as d3 from 'd3';
import { HomeMempoolTx } from '../../data/home';

@Component({
  selector: 'app-mempool',
  imports: [CommonModule],
  templateUrl: './mempool.html',
  styleUrl: './mempool.scss',
})
export class Mempool implements OnInit, OnDestroy, AfterViewInit, OnChanges {
  @ViewChild('containerFrame') containerFrame!: ElementRef<HTMLDivElement>;
  @ViewChild('fillLayer') fillLayer!: ElementRef<HTMLDivElement>;
  @ViewChild('emptyLayer') emptyLayer!: ElementRef<HTMLDivElement>;
  @ViewChild('tooltip') tooltip!: ElementRef<HTMLDivElement>;

  @Input() highlightedTxHash: string | null = null;
  @Input() mempoolTxs: HomeMempoolTx[] = [];
  @Input() blockLimit = 600000;
  @Input() wsConnected = false;
  @Output() hoverTx = new EventEmitter<string | null>();
  @Output() txClick = new EventEmitter<string>();

  totalUsed = 0;
  percentage = 0;

  txCount = 0;
  usedSizeStr = '0 kB';
  limitSizeStr = '600 kB';
  loadPctStr = '0%';
  loadPctColor = '';

  waterlineText = '0 kB Used';
  waterlineClass = '';

  private resizeObserver: ResizeObserver | undefined;

  constructor(private router: Router) { }

  ngOnInit(): void {
    this.updateStats();
    this.drawChart();
  }

  ngAfterViewInit() {
    this.resizeObserver = new ResizeObserver(() => {
      this.drawChart();
    });
    if (this.containerFrame) {
      this.resizeObserver.observe(this.containerFrame.nativeElement);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['highlightedTxHash']) {
      this.updateHighlight();
    }
    if (changes['mempoolTxs'] || changes['blockLimit']) {
      this.updateStats();
      this.drawChart();
    }
  }

  ngOnDestroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
  }

  updateStats() {
    this.totalUsed = this.mempoolTxs.reduce((acc, tx) => acc + tx.size * 1024, 0);
    this.percentage = this.totalUsed / this.blockLimit;
    this.txCount = this.mempoolTxs.length;
    this.usedSizeStr = (this.totalUsed / 1024).toFixed(1) + ' kB';
    this.limitSizeStr = (this.blockLimit / 1024).toFixed(1) + ' kB';
    this.loadPctStr = (this.percentage * 100).toFixed(1) + '%';

    if (this.percentage > 1.0) {
      const excess = (this.totalUsed - this.blockLimit) / 1024;
      this.waterlineText = `+ ${excess.toFixed(1)} kB Backlog`;
      this.waterlineClass = 'overflow';
      this.loadPctColor = 'var(--mempoolWaterlineOverflowColor)';
    } else {
      this.waterlineText = `${(this.totalUsed / 1024).toFixed(1)} kB Used`;
      this.waterlineClass = '';
      this.loadPctColor = '';
    }
  }

  updateHighlight() {
    if (!this.fillLayer) return;

    const fees = this.mempoolTxs.map((t) => t.fee);
    const minFee = d3.min(fees) || 0;
    const maxFee = d3.max(fees) || 1;
    const opacityScale = d3
      .scaleLinear()
      .domain([minFee, maxFee === minFee ? minFee + 1 : maxFee])
      .range([0.4, 1])
      .clamp(true);

    const svg = d3.select(this.fillLayer.nativeElement);
    svg
      .selectAll('rect.rect-node')
      .attr('stroke', (d: any) =>
        d.data.hash === this.highlightedTxHash
          ? 'var(--mempoolRectNodeHoverStroke)'
          : 'var(--mempoolRectNodeStroke)',
      )
      .attr('stroke-width', (d: any) => (d.data.hash === this.highlightedTxHash ? 2 : 0))
      .style('z-index', (d: any) => (d.data.hash === this.highlightedTxHash ? 10 : 1))
      .attr('fill-opacity', (d: any) => {
        const base = opacityScale(d.data.fee);
        if (this.highlightedTxHash) {
          return d.data.hash === this.highlightedTxHash ? 1 : base * 0.2;
        }
        return base;
      });
  }

  drawChart() {
    if (!this.containerFrame || !this.fillLayer || !this.emptyLayer) return;

    const containerW = this.containerFrame.nativeElement.clientWidth;
    const containerH = this.containerFrame.nativeElement.clientHeight;

    const clampedPct = Math.min(1.0, this.percentage);
    const fillWidth = Math.max(this.totalUsed > 0 ? 1 : 0, containerW * clampedPct);
    const emptyWidth = containerW - fillWidth;

    d3.select(this.fillLayer.nativeElement).style('width', `${fillWidth}px`);

    const colorOrange = 'var(--mempoolFillColor)';

    const fees = this.mempoolTxs.map((t) => t.fee);
    const minFee = d3.min(fees) || 0;
    const maxFee = d3.max(fees) || 1;

    const opacityScale = d3
      .scaleLinear()
      .domain([minFee, maxFee === minFee ? minFee + 1 : maxFee])
      .range([0.4, 1])
      .clamp(true);

    let svgFilled = d3.select(this.fillLayer.nativeElement).select<SVGSVGElement>('svg');
    if (svgFilled.empty()) {
      svgFilled = d3.select(this.fillLayer.nativeElement).append('svg');
    }
    svgFilled.attr('width', fillWidth).attr('height', containerH);

    if (this.mempoolTxs.length > 0) {
      const rootData = { children: this.mempoolTxs };
      const rootReal = d3
        .hierarchy(rootData)
        .sum((d: any) => d.size)
        .sort((a, b) => (b.data as any).fee - (a.data as any).fee);

      d3.treemap().size([fillWidth, containerH]).paddingInner(1).round(true)(rootReal as any);

      const t = svgFilled.transition().duration(30).ease(d3.easeLinear) as any;

      svgFilled
        .selectAll('rect.rect-node')
        .data(rootReal.leaves(), (d: any) => d.data.hash)
        .join(
          (enter) =>
            enter
              .append('rect')
              .attr('class', 'rect-node')
              .attr('x', (d: any) => d.x0)
              .attr('y', (d: any) => d.y0)
              .attr('width', (d: any) => d.x1 - d.x0)
              .attr('height', (d: any) => d.y1 - d.y0)
              .attr('fill', colorOrange)
              .attr('fill-opacity', 0)
              .style('cursor', 'pointer')
              .call((enter) =>
                enter.transition(t).attr('fill-opacity', (d: any) => opacityScale(d.data.fee)),
              ),
          (update) =>
            update.call((update) =>
              update
                .transition(t)
                .attr('x', (d: any) => d.x0)
                .attr('y', (d: any) => d.y0)
                .attr('width', (d: any) => d.x1 - d.x0)
                .attr('height', (d: any) => d.y1 - d.y0)
                .attr('fill-opacity', (d: any) => opacityScale(d.data.fee)),
            ),
          (exit) => exit.call((exit) => exit.transition(t).attr('fill-opacity', 0).remove()),
        )

        .on('mouseover', (event, d: any) => {
          this.hoverTx.emit(d.data.hash);
          const tooltip = d3.select(this.tooltip.nativeElement);
          tooltip
            .style('opacity', 1)
            .style('border-left', `4px solid ${colorOrange}`)
            .html(
              `<strong>TX: ${d.data.hash.substring(0, 10)}...</strong><br/>Size: ${d.data.size.toFixed(3)} kB<br/>Fee: ${d.data.fee}`,
            )
            .style('left', event.pageX + 15 + 'px')
            .style('top', event.pageY - 28 + 'px');
        })
        .on('mouseout', () => {
          this.hoverTx.emit(null);
          d3.select(this.tooltip.nativeElement).style('opacity', 0);
        })
        .on('click', (event, d: any) => {
          this.txClick.emit(d.data.hash);
        });
      this.updateHighlight();
    } else {
      svgFilled
        .selectAll('rect.rect-node')
        .transition()
        .duration(750)
        .attr('fill-opacity', 0)
        .remove();
    }

    d3.select(this.emptyLayer.nativeElement).selectAll('svg').remove();

    if (this.blockLimit > 0) {
      const ghostData = this.generateGhostData(this.blockLimit);
      const svgEmpty = d3
        .select(this.emptyLayer.nativeElement)
        .append('svg')
        .attr('width', containerW)
        .attr('height', containerH);

      const rootGhost = d3.hierarchy(ghostData).sum((d: any) => d.size);

      d3.treemap().size([containerW, containerH]).paddingInner(2).round(true)(rootGhost as any);

      svgEmpty
        .selectAll('rect')
        .data(rootGhost.leaves())
        .join('rect')
        .attr('class', 'ghost-node')
        .attr('x', (d: any) => d.x0)
        .attr('y', (d: any) => d.y0)
        .attr('width', (d: any) => d.x1 - d.x0)
        .attr('height', (d: any) => d.y1 - d.y0)
        .attr('fill', 'var(--mempoolGhostNodeFill)')
        .attr('fill-opacity', 0.3);
    }
  }

  generateGhostData(bytesToFill: number) {
    const ghosts = [];
    let currentBytes = 0;
    while (currentBytes < bytesToFill) {
      const isLarge = Math.random() > 0.98;
      const size = isLarge ? 30000 : 3000 + Math.random() * 4000;
      if (currentBytes + size > bytesToFill) {
        ghosts.push({ size: bytesToFill - currentBytes });
        break;
      }
      ghosts.push({ size: size });
      currentBytes += size;
    }
    return { children: ghosts };
  }

  public navigateToGlossary(input: string) {
    this.router.navigate(['/glossary'], { fragment: input });
  }
}
