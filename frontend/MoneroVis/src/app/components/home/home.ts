import { Component, OnInit, inject, signal, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { HomeService } from '../../service/home.service';
import { HomeData, HomeMempoolTx, HomeBlock } from '../../data/home';
import { Mempool } from '../mempool/mempool';
import { Loader } from '../loader/loader';
import * as d3 from 'd3';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, Mempool, Loader],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class Home implements OnInit, OnDestroy {
  private homeService = inject(HomeService);
  private ngZone = inject(NgZone);

  homeData: HomeData | null = null;
  isLoading = signal(true);
  displayLimit = signal(10);
  hoveredTxHash = signal<string | null>(null);
  wsConnected = signal(false);

  private opacityScale: any;
  private socket: WebSocket | null = null;
  private intervalId: any;
  private flushInterval: any;

  private mempoolHashes = new Set<string>();
  private bufferHashes = new Set<string>();
  private txBuffer: HomeMempoolTx[] = [];
  private minFee = 0;
  private maxFee = 1;

  constructor(private router: Router) {}

  ngOnInit() {
    this.isLoading.set(true);
    this.homeService.getHomeData().subscribe({
      next: (data) => {
        this.homeData = data;
        if (this.homeData && this.homeData.blocks) {
          this.homeData.blocks.forEach((block) => {
            block.relativeTime = this.getRelativeTime(block.timestamp);
          });
        }
        if (this.homeData?.mempool) {
          this.mempoolHashes = new Set(this.homeData.mempool.map((tx) => tx.hash));
        }
        this.calculateOpacityScale(true);
        this.isLoading.set(false);
        this.connectWebSocket();
        this.intervalId = setInterval(() => {
          this.updateRelativeTimes();
        }, 60000);

        this.ngZone.runOutsideAngular(() => {
          this.flushInterval = setInterval(() => {
            this.flushBuffer();
          }, 500);
        });
      },
      error: (err) => {
        console.error('Failed to fetch home data', err);
        this.isLoading.set(false);
      },
    });
  }

  ngOnDestroy() {
    if (this.socket) {
      this.socket.close();
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
  }

  connectWebSocket() {
    this.ngZone.runOutsideAngular(() => {
      this.socket = new WebSocket('wss://ws.monerovis.com');
      this.socket.onopen = () => {
        this.ngZone.run(() => this.wsConnected.set(true));
      };
      this.socket.onclose = () => {
        this.ngZone.run(() => this.wsConnected.set(false));
      };
      this.socket.onerror = (error) => {
        console.error('WebSocket error', error);
        this.ngZone.run(() => this.wsConnected.set(false));
      };
      this.socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.event === 'new_transaction' && this.homeData) {
            const hash = msg.data.hash;
            if (this.mempoolHashes.has(hash) || this.bufferHashes.has(hash)) return;

            const newTx: HomeMempoolTx = {
              hash: hash,
              fee: msg.data.fee / 1000000000000,
              size: msg.data.size_bytes / 1024,
              inputs: msg.data.inputs,
              outputs: msg.data.outputs,
              isNew: true,
            };
            this.bufferHashes.add(hash);
            this.txBuffer.push(newTx);
          } else if (msg.event === 'new_block' && this.homeData) {
            this.ngZone.run(() => {
              this.flushBuffer(true);

              const newBlock: HomeBlock = {
                height: msg.data.height,
                hash: msg.data.hash,
                txCount: msg.data.tx_count,
                reward: msg.data.total_reward / 1000000000000,
                relativeTime: this.getRelativeTime(msg.data.timestamp),
                timestamp: msg.data.timestamp,
                isNew: true,
              };

              const confirmedHashes = new Set<string>(msg.data.tx_hashes || []);
              const updatedMempool: HomeMempoolTx[] = [];
              this.mempoolHashes.clear();

              for (const tx of this.homeData!.mempool) {
                if (!confirmedHashes.has(tx.hash)) {
                  updatedMempool.push(tx);
                  this.mempoolHashes.add(tx.hash);
                }
              }

              this.homeData = {
                ...this.homeData!,
                mempool: updatedMempool,
                blocks: [newBlock, ...this.homeData!.blocks.slice(0, -1)],
              };
              this.calculateOpacityScale(true);
            });
          }
        } catch (e) {
          console.error('WebSocket error', e);
        }
      };
    });
  }

  flushBuffer(force: boolean = false) {
    if (this.txBuffer.length === 0) return;

    this.ngZone.run(() => {
      if (!this.homeData) return;

      const bufferCopy = [...this.txBuffer];
      this.txBuffer = [];
      this.bufferHashes.clear();

      bufferCopy.forEach((tx) => this.mempoolHashes.add(tx.hash));

      this.homeData = {
        ...this.homeData,
        mempool: [...bufferCopy, ...this.homeData.mempool],
      };

      if (bufferCopy.length > 0) {
        const fees = bufferCopy.map((t) => t.fee);
        const minBufferFee = d3.min(fees) || 0;
        const maxBufferFee = d3.max(fees) || 0;

        let changed = false;
        if (minBufferFee < this.minFee) {
          this.minFee = minBufferFee;
          changed = true;
        }
        if (maxBufferFee > this.maxFee) {
          this.maxFee = maxBufferFee;
          changed = true;
        }

        if (changed || this.homeData.mempool.length === bufferCopy.length) {
          this.calculateOpacityScale(false);
        }
      }
    });
  }

  getRelativeTime(timestampSeconds: number): string {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestampSeconds;

    if (diff < 60) return 'seconds ago';

    if (diff < 3600) {
      const minutes = Math.floor(diff / 60);
      return minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`;
    }

    const hours = Math.floor(diff / 3600);
    return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  }

  updateRelativeTimes() {
    if (this.homeData && this.homeData.blocks) {
      this.homeData.blocks.forEach((block) => {
        block.relativeTime = this.getRelativeTime(block.timestamp);
      });
    }
  }

  setHoveredTx(hash: string | null) {
    this.hoveredTxHash.set(hash);
  }

  calculateOpacityScale(fullRecalc: boolean = false, newFee?: number) {
    if (!this.homeData || !this.homeData.mempool) return;

    if (fullRecalc) {
      if (this.homeData.mempool.length === 0) {
        this.minFee = 0;
        this.maxFee = 1;
      } else {
        const fees = this.homeData.mempool.map((t) => t.fee);
        this.minFee = d3.min(fees) || 0;
        this.maxFee = d3.max(fees) || 1;
      }
    } else if (newFee !== undefined) {
      let changed = false;
      if (newFee < this.minFee) {
        this.minFee = newFee;
        changed = true;
      }
      if (newFee > this.maxFee) {
        this.maxFee = newFee;
        changed = true;
      }
      if (!changed) return;
    }

    this.opacityScale = d3
      .scaleLinear()
      .domain([this.minFee, this.maxFee === this.minFee ? this.minFee + 1 : this.maxFee])
      .range([0.4, 1])
      .clamp(true);
  }

  getOpacity(tx: HomeMempoolTx): number {
    if (!this.opacityScale) return 1;
    return this.opacityScale(tx.fee);
  }

  increaseLimit() {
    this.displayLimit.set(this.homeData?.mempool?.length || 10000);
  }

  public navigateToBlock(height: number) {
    this.router.navigate(['/block/' + height]);
  }

  public navigateToBlocks() {
    this.router.navigate(['/blocks/']);
  }

  public navigateToTx(hash: string) {
    this.router.navigate(['/tx/' + hash]);
  }
}
