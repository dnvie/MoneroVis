import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
  ChangeDetectorRef,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router, ActivatedRoute } from '@angular/router';
import { BlockListEntry } from '../../data/block';
import { BlocksService } from '../../service/block.service';
import { Loader } from '../loader/loader';
import { ModalService } from '../../service/modal.service';

import * as d3 from 'd3';

@Component({
  selector: 'app-blocks',
  standalone: true,
  imports: [CommonModule, RouterModule, Loader],
  templateUrl: './blocks.html',
  styleUrl: './blocks.scss',
})
export class Blocks implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('chartContainer') chartContainer!: ElementRef;

  private modalService = inject(ModalService);

  blocks: BlockListEntry[] = [];
  isLoading = signal(true);
  private resizeTimer: any;
  numbers = Array.from({ length: 25 }, (_, i) => i + 1);

  currentPage = 1;
  totalPages = 1;
  totalBlocks = 0;

  private isDragging = false;
  private startX = 0;
  private startScrollLeft = 0;
  private hasDragged = false;

  private targetScrollLeft = 0;
  private isAnimatingScroll = false;

  isInstantScroll = signal(localStorage.getItem('monerovis_instant_scroll') === 'true');

  hoveredBlockHeight: number | null = null;
  constructor(
    private blocksService: BlocksService,
    private cdr: ChangeDetectorRef,
    private router: Router,
    private route: ActivatedRoute,
  ) { }

  toggleScrollMode() {
    const newState = !this.isInstantScroll();
    this.isInstantScroll.set(newState);
    localStorage.setItem('monerovis_instant_scroll', String(newState));
  }

  ngOnInit(): void {
    this.route.queryParams.subscribe((params) => {
      const page = parseInt(params['page'] || '1', 10);
      this.currentPage = page;
      this.loadBlocks(page);
    });
  }

  loadBlocks(page: number) {
    this.isLoading.set(true);
    this.cdr.detectChanges();
    this.blocksService.getBlocks(page).subscribe({
      next: (response) => {
        this.blocks = response.blocks;
        this.totalPages = response.totalPages;
        this.totalBlocks = response.totalBlocks;
        this.isLoading.set(false);
        this.cdr.detectChanges();
        setTimeout(() => this.drawChart(), 0);
      },
      error: (error) => {
        console.error('Error fetching blocks:', error);
        this.isLoading.set(false);
      },
    });
  }

  onPageChange(page: number | string) {
    if (typeof page === 'string') return;
    if (page < 1 || page > this.totalPages || page === this.currentPage) return;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { page: page },
      queryParamsHandling: 'merge',
    });
  }

  get pages(): (number | string)[] {
    const p = [];
    const total = this.totalPages;
    const current = this.currentPage;

    if (total <= 7) {
      for (let i = 1; i <= total; i++) p.push(i);
    } else {
      p.push(1);
      if (current > 3) p.push('...');

      let start = Math.max(2, current - 1);
      let end = Math.min(total - 1, current + 1);

      if (current <= 3) end = 4;
      if (current >= total - 2) start = total - 3;

      for (let i = start; i <= end; i++) p.push(i);

      if (current < total - 2) p.push('...');
      p.push(total);
    }
    return p;
  }

  ngAfterViewInit(): void {
    if (!this.isLoading() && this.blocks.length > 0) {
      this.drawChart();
    }
  }

  ngOnDestroy(): void {
    clearTimeout(this.resizeTimer);
    this.isAnimatingScroll = false;
  }

  @HostListener('window:resize')
  onResize() {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.drawChart(), 200);
  }

  private performSmoothScroll(element: HTMLElement) {
    if (!this.isAnimatingScroll) return;

    const current = element.scrollLeft;
    const diff = this.targetScrollLeft - current;

    if (Math.abs(diff) < 1) {
      element.scrollLeft = this.targetScrollLeft;
      this.isAnimatingScroll = false;
      return;
    }

    element.scrollLeft = current + diff * 0.5;
    requestAnimationFrame(() => this.performSmoothScroll(element));
  }

  drawChart() {
    if (!this.chartContainer || this.blocks.length === 0) {
      return;
    }

    const element = this.chartContainer.nativeElement;
    d3.select(element).selectAll('*').remove();

    const height = 300;
    const baseReward = 0.6;

    const pixelsPerMinute = 40;
    const minGap = 60;
    const maxVisualMinutes = 8;

    const minBlockSize = 50;
    const maxBlockSize = 120;
    const borderRadius = 2;

    const roundedRect = (
      x: number,
      y: number,
      w: number,
      h: number,
      r: number,
      tl: boolean,
      tr: boolean,
      bl: boolean,
      br: boolean,
    ) => {
      const r_eff = Math.min(r, w / 2, h / 2);
      return `M${x + r_eff},${y}
                h${w - 2 * r_eff}
                ${tr ? `a${r_eff},${r_eff} 0 0 1 ${r_eff},${r_eff}` : `h${r_eff}v${r_eff}`}
                v${h - 2 * r_eff}
                ${br ? `a${r_eff},${r_eff} 0 0 1 -${r_eff},${r_eff}` : `v${r_eff}h-${r_eff}`}
                h${-w + 2 * r_eff}
                ${bl ? `a${r_eff},${r_eff} 0 0 1 -${r_eff},-${r_eff}` : `h-${r_eff}v-${r_eff}`}
                v${-h + 2 * r_eff}
                ${tl ? `a${r_eff},${r_eff} 0 0 1 ${r_eff},-${r_eff}` : `v-${r_eff}h${r_eff}`}
                z`.replace(/\s+/g, ' ');
    };

    const timeColorScale = d3
      .scaleLinear<string>()
      .domain([0, 2, 10])
      .range(['#e04040', '#2eb358', '#e04040'])
      .clamp(true);

    const dataRaw = [...this.blocks].sort((a, b) => a.height - b.height);
    const finalData: any[] = [];

    const maxTx = d3.max(dataRaw, (d) => d.txCount || 0) || 100;
    const sizeScale = d3
      .scaleLinear()
      .domain([0, Math.max(150, maxTx)])
      .range([minBlockSize, maxBlockSize]);

    const fees = dataRaw.map((d) => d.reward || 0);
    const minFee = d3.min(fees) || 0;
    const maxFee = d3.max(fees) || 0;

    const opacityScale = d3.scaleLinear().domain([minFee, maxFee]).range([0.15, 1]).clamp(true);

    dataRaw.forEach((b, i) => {
      let ts = (b as any).timestampRaw;
      if (!ts) {
        const timeStr = b.timestamp ? b.timestamp.replace(' ', 'T') : '';
        ts = new Date(timeStr).getTime() / 1000;
        if (isNaN(ts)) {
          ts = new Date().getTime() / 1000 - (dataRaw.length - i) * 120;
        }
      }

      let minutesDelta = 2;
      if (i > 0) {
        let prevTs = (dataRaw[i - 1] as any).timestampRaw;
        if (!prevTs) {
          const prevTimeStr = dataRaw[i - 1].timestamp
            ? dataRaw[i - 1].timestamp.replace(' ', 'T')
            : '';
          prevTs = new Date(prevTimeStr).getTime() / 1000;
          if (isNaN(prevTs)) prevTs = ts - 120;
        }
        minutesDelta = (ts - prevTs) / 60.0;
      }

      if (isNaN(minutesDelta)) minutesDelta = 2;
      if (minutesDelta < 0) minutesDelta = 0;

      const fee = b.reward;
      const txCount = b.txCount || 0;
      const size = sizeScale(txCount);
      const opacity = opacityScale(fee);

      let x = 100;
      if (i > 0) {
        const prev = finalData[i - 1];
        const prevX = isNaN(prev.x) ? 100 : prev.x;
        const prevSize = isNaN(prev.size) ? minBlockSize : prev.size;

        let visualMinutes = minutesDelta;
        if (visualMinutes > maxVisualMinutes) visualMinutes = maxVisualMinutes;

        let gap = visualMinutes * pixelsPerMinute;
        if (gap < minGap) gap = minGap;

        x = prevX + prevSize / 2 + gap + size / 2;
      }

      finalData.push({
        ...b,
        minutesDelta,
        fee: fee > 0 ? fee : 0,
        txCount: txCount,
        size: size,
        opacity: opacity,
        x: x,
      });
    });

    let lastX = finalData[finalData.length - 1].x;
    if (isNaN(lastX)) lastX = 1000;
    const totalContentWidth = lastX + finalData[finalData.length - 1].size / 2 + 100;

    const svgWidth = Math.max(element.clientWidth, totalContentWidth);

    const svg = d3
      .select(element)
      .append('svg')
      .attr('width', svgWidth)
      .attr('height', height)
      .style('display', 'block');

    const containerGroup = svg.append('g').attr('class', 'chart-container-g');
    const centerY = height / 2;

    const blocks = containerGroup
      .selectAll('.block-group')
      .data(finalData)
      .enter()
      .append('g')
      .attr('class', 'block-group')
      .attr('id', (d: any) => 'block-group-' + d.height)
      .attr('transform', (d) => `translate(${isNaN(d.x) ? 0 : d.x}, ${centerY})`)
      .style('cursor', 'pointer');

    blocks.each(function (d: any, i) {
      if (i > 0) {
        const prev = finalData[i - 1];
        const startX = -(d.size / 2);
        const distToPrevCenter = d.x - prev.x;
        const prevRightEdge = -distToPrevCenter + prev.size / 2;

        if (isNaN(startX) || isNaN(prevRightEdge)) return;

        const lineGroup = d3
          .select(this)
          .append('g')
          .attr('class', 'connection')
          .style('cursor', 'default');

        lineGroup
          .on('mouseover', (e) => e.stopPropagation())
          .on('mouseout', (e) => e.stopPropagation())
          .on('click', (e) => e.stopPropagation());

        const lineColor = timeColorScale(d.minutesDelta);

        lineGroup
          .append('line')
          .attr('x1', startX)
          .attr('y1', 0)
          .attr('x2', prevRightEdge)
          .attr('y2', 0)
          .attr('stroke', lineColor)
          .attr('stroke-width', 2);

        const lineCenter = (startX + prevRightEdge) / 2;

        const totalSeconds = Math.round(d.minutesDelta * 60);
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;

        let timeLabel = `${s}s`;
        if (h > 0) {
          timeLabel = `${h}h ${m}m ${s}s`;
        } else if (m > 0) {
          timeLabel = `${m}m ${s}s`;
        }

        const labelWidth = timeLabel.length * 7 + 12;

        lineGroup
          .append('rect')
          .attr('x', lineCenter - labelWidth / 2)
          .attr('y', -10)
          .attr('width', labelWidth)
          .attr('height', 20)
          .attr('fill', 'var(--background)')
          .attr('opacity', 0.9)
          .attr('rx', 4);

        lineGroup
          .append('text')
          .attr('class', 'edge-label')
          .attr('x', lineCenter)
          .attr('y', 4)
          .attr('text-anchor', 'middle')
          .attr('fill', lineColor)
          .attr('font-size', '11px')
          .attr('font-family', 'Google Sans Code')
          .attr('font-weight', 'bold')
          .text(timeLabel);
      }
    });

    blocks
      .append('path')
      .attr('class', 'base-rect')
      .attr('d', (d: any) => {
        return roundedRect(
          -d.size / 2,
          -d.size / 2,
          d.size,
          d.size,
          borderRadius,
          true,
          true,
          true,
          true,
        );
      })
      .attr('fill', '#F26822')
      .attr('opacity', (d: any) => d.opacity)
      .attr('stroke', 'none');

    // Labels
    blocks
      .append('text')
      .text((d: any) => '#' + d.height)
      .attr('y', (d: any) => d.size / 2 + 20)
      .attr('text-anchor', 'middle')
      .attr('fill', 'var(--text)')
      .attr('font-size', '12px')
      .attr('font-family', 'Google Sans Code');

    blocks
      .append('text')
      .text((d: any) => d.txCount + ' txs')
      .attr('y', (d: any) => d.size / 2 + 35)
      .attr('text-anchor', 'middle')
      .attr('fill', 'var(--textLighter)')
      .attr('font-size', '10px');

    blocks
      .on('mouseover', (event, d: any) => {
        const currentHeight = d.height;
        this.hoveredBlockHeight = currentHeight;

        containerGroup.selectAll('.block-group').each(function (bd: any) {
          const isTarget = bd.height === currentHeight;
          d3.select(this)
            .select('.base-rect')
            .attr('fill', isTarget ? 'var(--text)' : '#F26822')
            .attr('opacity', isTarget ? 1 : bd.opacity)
            .attr('stroke', 'none');
        });
        this.cdr.detectChanges();
      })
      .on('mouseout', (event, d: any) => {
        containerGroup.selectAll('.block-group').each(function (bd: any) {
          d3.select(this)
            .select('.base-rect')
            .attr('fill', '#F26822')
            .attr('opacity', bd.opacity)
            .attr('stroke', 'none');
        });

        this.hoveredBlockHeight = null;
        this.cdr.detectChanges();
      })
      .on('click', (event, d: any) => {
        if (this.hasDragged) return;
        this.router.navigate(['/block', d.height]);
      });

    const container = d3.select(element);

    container.on('wheel', (event: WheelEvent) => {
      if (element.scrollWidth > element.clientWidth) {
        event.preventDefault();

        if (!this.isAnimatingScroll) {
          this.targetScrollLeft = element.scrollLeft;
          this.isAnimatingScroll = true;
          requestAnimationFrame(() => this.performSmoothScroll(element));
        }

        this.targetScrollLeft -= event.deltaY;

        const maxScroll = element.scrollWidth - element.clientWidth;
        if (this.targetScrollLeft < 0) this.targetScrollLeft = 0;
        if (this.targetScrollLeft > maxScroll) this.targetScrollLeft = maxScroll;
      }
    });

    container.on('mousedown', (event: MouseEvent) => {
      this.isAnimatingScroll = false;
      this.isDragging = true;
      this.hasDragged = false;
      this.startX = event.pageX;
      this.startScrollLeft = element.scrollLeft;
      container.style('cursor', 'grabbing');
    });

    container.on('mouseup', () => {
      this.isDragging = false;
      container.style('cursor', 'grab');
    });

    container.on('mouseleave', () => {
      this.isDragging = false;
      container.style('cursor', 'grab');
    });

    container.on('mousemove', (event: MouseEvent) => {
      if (!this.isDragging) return;
      event.preventDefault();
      const x = event.pageX;
      const walk = x - this.startX;
      if (Math.abs(walk) > 5) this.hasDragged = true;
      element.scrollLeft = this.startScrollLeft - walk;
    });

    setTimeout(() => {
      element.scrollLeft = element.scrollWidth;
      this.targetScrollLeft = element.scrollLeft;
    }, 0);
  }

  public navigateToBlock(height: number) {
    this.router.navigate(['/block/' + height]);
  }

  public navigateToHome() {
    this.router.navigate(['/']);
  }

  onListHover(height: number | null) {
    this.hoveredBlockHeight = height;

    if (!this.chartContainer) return;

    if (this.isInstantScroll() && height !== null) return;

    const container = d3.select(this.chartContainer.nativeElement);

    if (height !== null) {
      container.selectAll('.block-group').each(function (d: any) {
        const isTarget = d.height === height;
        d3.select(this)
          .select('.base-rect')
          .attr('fill', isTarget ? 'var(--text)' : '#F26822')
          .attr('opacity', isTarget ? 1 : d.opacity)
          .attr('stroke', 'none');
      });

      const group = container.select('#block-group-' + height);
      if (!group.empty()) {
        const d: any = group.datum();
        if (d && !this.isInstantScroll()) {
          this.centerBlockInView(d.x);
        }
      }
    } else {
      container.selectAll('.block-group').each(function (d: any) {
        d3.select(this)
          .select('.base-rect')
          .attr('fill', '#F26822')
          .attr('opacity', d.opacity)
          .attr('stroke', 'none');
      });
    }
  }

  private centerBlockInView(x: number) {
    const element = this.chartContainer.nativeElement;
    const containerWidth = element.clientWidth;
    const targetScroll = x - containerWidth / 2;
    const maxScroll = element.scrollWidth - containerWidth;

    const finalScroll = Math.max(0, Math.min(targetScroll, maxScroll));
    this.targetScrollLeft = finalScroll;

    if (this.isInstantScroll()) {
      element.scrollLeft = finalScroll;
      this.isAnimatingScroll = false;
    } else {
      if (!this.isAnimatingScroll) {
        this.isAnimatingScroll = true;
        this.performSmoothScroll(element);
      }
    }
  }

  toggleLegend() {
    this.modalService.open('blocksLegend');
  }

  public navigateToGlossary(input: string) {
    this.router.navigate(['/glossary'], { fragment: input });
  }
}
