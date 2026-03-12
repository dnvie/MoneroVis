import { CommonModule } from '@angular/common';
import {
  Component,
  Input,
  OnChanges,
  OnInit,
  ViewEncapsulation,
  ChangeDetectorRef,
  HostListener,
  signal,
  OnDestroy,
} from '@angular/core';
import { Router, ActivatedRoute, NavigationEnd } from '@angular/router';
import { TransactionService } from '../../service/transaction.service';
import { Transaction, TransactionJson } from '../../data/transaction';
import { Loader } from '../loader/loader';
import { filter } from 'rxjs/operators';
import { Subscription } from 'rxjs';
import { Title } from '@angular/platform-browser';
import { TransactionGraph } from '../transaction-graph/transaction-graph';
import { DecoyService } from '../../service/decoy.service';

interface ExtraSegment {
  isRaw: boolean;
  value: string;
  label?: string;
  labelColorClass?: string;
  wrapperClass?: string;
  valueClass?: string;
}

@Component({
  selector: 'app-transaction',
  templateUrl: './transaction.html',
  styleUrls: ['./transaction.scss'],
  encapsulation: ViewEncapsulation.None,
  imports: [CommonModule, Loader, TransactionGraph],
  standalone: true,
})
export class TransactionComponent implements OnInit, OnChanges, OnDestroy {
  @Input() transactionData: Transaction | null = null;
  public isLoading = signal(true);
  public highlightedAddress = signal<string | null>(null);
  public suspiciousRingMembers = signal<{ rm: any; reason: string; colorClass: string }[]>([]);
  public hasLoaded = signal(false);
  public sharedParentHashes = new Set<string>();

  public parsedExtra: ExtraSegment[] = [];
  public transactionJson: TransactionJson | null = null;
  public isJsonVisible = signal(false);

  public outputsLimit = signal(15);
  public notableRMsLimit = signal(15);
  public inputsLimit = signal(2);

  private currentActiveHash: string = '';

  txPathText = signal(this.getTxPathText());
  private routeSub?: Subscription;
  private queryParamSub?: Subscription;

  constructor(
    private transactionService: TransactionService,
    private route: ActivatedRoute,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private titleService: Title,
    private decoyService: DecoyService,
  ) {
    this.router.events
      .pipe(filter((rs): rs is NavigationEnd => rs instanceof NavigationEnd))
      .subscribe((event) => {
        if (event.id === 1 && event.url === event.urlAfterRedirects) {
        }
      });
  }

  toggleJson() {
    if (this.isJsonVisible()) {
      this.isJsonVisible.set(false);
    } else {
      if (this.transactionJson) {
        this.isJsonVisible.set(true);
      } else if (this.transactionData && this.transactionData.tx_hash) {
        this.transactionService.getTransactionJson(this.transactionData.tx_hash).subscribe({
          next: (data) => {
            this.transactionJson = data;
            this.isJsonVisible.set(true);
            this.cdr.detectChanges();
          },
          error: (err) => {
            console.error('Error loading transaction JSON:', err);
          },
        });
      }
    }
  }

  increaseOutputsLimit() {
    this.outputsLimit.set(this.transactionData?.outputs.length || 10000);
  }

  increaseNotableRMsLimit() {
    this.notableRMsLimit.set(this.suspiciousRingMembers().length);
  }

  increaseInputsLimit() {
    this.inputsLimit.set(this.transactionData?.inputs.length || 10000);
  }

  @HostListener('window:resize')
  onResize() {
    this.txPathText.set(this.getTxPathText());
  }

  private getTxPathText(): string {
    return window.innerWidth < 400 ? 'Tx' : 'Transaction';
  }

  public toggleRingMembers(key_image: string) {}
  public isRingMembersCollapsed(key_image: string): boolean {
    return false;
  }

  ngOnInit(): void {
    this.queryParamSub = this.route.queryParams.subscribe((params) => {
      const highlight = params['highlight'];
      this.highlightedAddress.set(highlight || null);
    });

    this.routeSub = this.route.paramMap.subscribe((params) => {
      const hash = params.get('hash');
      if (hash) {
        this.loadTransaction(hash);
      }
    });
  }

  ngOnChanges(): void {
    if (this.transactionData) {
      this.processTransaction(this.transactionData);
    }
  }

  private loadTransaction(hash: string): void {
    this.isLoading.set(true);
    this.hasLoaded.set(false);
    this.currentActiveHash = hash;
    this.transactionData = null;
    this.cdr.detectChanges();

    this.transactionService.getTransaction(hash).subscribe({
      next: (data: Transaction) => {
        if (this.currentActiveHash !== hash) return;

        this.processTransaction(data);
        this.titleService.setTitle('Tx #' + data.tx_hash.substring(0, 8) + '... · MoneroVis.com');
      },
      error: (err) => {
        if (this.currentActiveHash !== hash) return;
        console.error('Error loading transaction:', err);
        this.isLoading.set(false);
        this.cdr.detectChanges();
      },
    });
  }

  private processTransaction(data: Transaction): void {
    if (data && data.tx_hash) {
      this.currentActiveHash = data.tx_hash;
    }
    this.transactionData = data;

    if (data.extra) {
      this.parseExtra(data.extra);
    } else {
      this.parsedExtra = [];
    }

    const suspicious: { rm: any; reason: string; colorClass: string }[] = [];
    const unspendableHashes = [
      '0000000000000000000000000000000000000000000000000000000000000000',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead000f',
    ];

    const parentCounts = new Map<string, number>();
    if (data && data.inputs) {
      for (const input of data.inputs) {
        if (!input.ring_members) continue;
        for (const rm of input.ring_members) {
          const count = parentCounts.get(rm.parent_transaction) || 0;
          parentCounts.set(rm.parent_transaction, count + 1);
        }
      }
    }
    this.sharedParentHashes.clear();
    for (const [parent, count] of parentCounts.entries()) {
      if (count > 1) {
        this.sharedParentHashes.add(parent);
      }
    }

    if (data && data.inputs) {
      for (const input of data.inputs) {
        if (!input.ring_members) continue;
        for (const rm of input.ring_members) {
          if (unspendableHashes.includes(rm.hash)) {
            suspicious.push({ rm, reason: 'Unspendable Decoy', colorClass: 'circle-red' });
          } else if (rm.is_coinbase) {
            suspicious.push({
              rm,
              reason: 'Coinbase Parent',
              colorClass: 'circle-darkblue',
            });
          } else if (this.sharedParentHashes.has(rm.parent_transaction)) {
            suspicious.push({
              rm,
              reason: 'Shared Parent',
              colorClass: 'circle-black',
            });
          } else if (data.block_height - rm.block_height === 10) {
            suspicious.push({ rm, reason: '10-Block Bug', colorClass: 'circle-blue' });
          }
        }
      }
    }
    this.suspiciousRingMembers.set(suspicious);

    this.isLoading.set(false);
    this.hasLoaded.set(true);
    this.cdr.detectChanges();
  }

  private parseExtra(extraHex: string) {
    this.parsedExtra = [];
    if (!extraHex) return;

    let currentIndex = 0;

    while (currentIndex < extraHex.length) {
      const tag = extraHex.substring(currentIndex, currentIndex + 2);

      if (tag === '01') {
        this.parsedExtra.push({ isRaw: true, value: '01' });
        currentIndex += 2;

        const pubkey = extraHex.substring(currentIndex, currentIndex + 64);
        if (pubkey.length === 64) {
          this.parsedExtra.push({
            isRaw: false,
            value: pubkey,
            label: 'Tx PubKey',
            labelColorClass: 'green',
            wrapperClass: 'pubkeySpan',
            valueClass: 'pubkey',
          });
          currentIndex += 64;
          continue;
        }
      }

      if (tag === '04') {
        this.parsedExtra.push({ isRaw: true, value: '04' });
        currentIndex += 2;

        const numKeysHex = extraHex.substring(currentIndex, currentIndex + 2);
        const numKeys = parseInt(numKeysHex, 16);

        this.parsedExtra.push({ isRaw: true, value: numKeysHex });
        currentIndex += 2;

        for (let i = 0; i < numKeys; i++) {
          const additionalKey = extraHex.substring(currentIndex, currentIndex + 64);

          if (additionalKey.length === 64) {
            this.parsedExtra.push({
              isRaw: false,
              value: additionalKey,
              label: `Add. PubKey ${i + 1}`,
              labelColorClass: 'green',
              wrapperClass: 'pubkeySpan',
              valueClass: 'pubkey',
            });
            currentIndex += 64;
          } else {
            break;
          }
        }
        continue;
      }

      if (tag === '02') {
        const nonceLengthHex = extraHex.substring(currentIndex + 2, currentIndex + 4);
        const nonceType = extraHex.substring(currentIndex + 4, currentIndex + 6);

        if (nonceLengthHex === '09' && nonceType === '01') {
          this.parsedExtra.push({ isRaw: true, value: '020901' });
          currentIndex += 6;

          const paymentId = extraHex.substring(currentIndex, currentIndex + 16);
          if (paymentId.length === 16) {
            this.parsedExtra.push({
              isRaw: false,
              value: paymentId,
              label: 'Payment ID',
              labelColorClass: 'blue',
              wrapperClass: 'paymentIdSpan',
              valueClass: 'paymentId',
            });
            currentIndex += 16;
            continue;
          }
        }

        if (nonceLengthHex === '21' && nonceType === '00') {
          this.parsedExtra.push({ isRaw: true, value: '022100' });
          currentIndex += 6;

          const paymentId = extraHex.substring(currentIndex, currentIndex + 64);
          if (paymentId.length === 64) {
            this.parsedExtra.push({
              isRaw: false,
              value: paymentId,
              label: 'Payment ID',
              labelColorClass: 'blue',
              wrapperClass: 'paymentIdSpan',
              valueClass: 'paymentId',
            });
            currentIndex += 64;
            continue;
          }
        }
      }

      this.parsedExtra.push({ isRaw: true, value: tag });
      currentIndex += 2;
    }
  }

  public isSharedParent(parentTx: string): boolean {
    return this.sharedParentHashes.has(parentTx);
  }

  public navigateToDecoyMap(hash: string, key: string, index: number, version: number) {
    if (version <= 1 || index == 0) {
      this.unsupportedAlert();
    } else {
      this.decoyService.openWithTxParams(hash, key, index);
    }
  }

  public navigateToParentTx(txHash: string, ringMemberHash: string) {
    this.router.navigate(['/tx', txHash], {
      queryParams: { highlight: ringMemberHash },
    });
  }

  public unsupportedAlert() {
    window.alert('pre-RingCT transactions with version 1 or lower are not supported');
  }

  public navigateToBlock(height: number) {
    this.router.navigate(['/block/' + height]);
  }

  public navigateToBlocks() {
    this.router.navigate(['/blocks/']);
  }

  public navigateToHome() {
    this.router.navigate(['/']);
  }

  public navigateToGlossary(input: string) {
    this.router.navigate(['/glossary'], { fragment: input });
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
    this.queryParamSub?.unsubscribe();
  }
}
