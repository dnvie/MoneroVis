import {
  Component,
  ElementRef,
  HostListener,
  inject,
  signal,
  computed,
  Output,
  EventEmitter,
  effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import {
  ClipboardService,
  ClipboardItem,
  HashboardTab,
} from '../../service/clipboard.service';
import { OutputTransactionsMap } from '../../data/decoy_transaction';
import { MergingResult } from '../../data/merging_result';
import { Transaction } from '../../data/transaction';

@Component({
  selector: 'app-clipboard',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './clipboard.html',
  styleUrls: ['./clipboard.scss'],
})
export class Clipboard {
  public service = inject(ClipboardService);
  private elementRef = inject(ElementRef);

  @Output() automatedTraceComplete = new EventEmitter<{
    result: MergingResult;
    colors: string[];
  }>();
  @Output() clearAutomatedTrace = new EventEmitter<void>();

  isOpen = signal(false);
  showNewGroupForm = signal(false);
  collapsedGroups = signal(new Set<string>());
  editingGroupId = signal<string | null>(null);
  editingTabId = signal<string | null>(null);
  justCopiedGroupId = signal<string | null>(null);
  justCopiedAll = signal(false);

  isLoading = signal(false);
  automatedResultColors = signal<string[]>([]);

  groupDisplayLimits = signal<Map<string, number>>(new Map());
  readonly INITIAL_DISPLAY_LIMIT = 100;

  tempGroupName = '';
  tempTabName = '';

  inputValue = '';
  selectedCategoryId = 'default';
  addMode: 'manual' | 'indices' | 'hashes' = 'hashes';
  batchInputValue = '';

  newGroupName = '';
  newGroupColor = '#0d6efd';

  totalAutomatedCount = computed(() => {
    const results = this.service.automatedResults();
    if (!results || results.length <= 1) return 0;
    return results.slice(1).reduce((sum, group) => sum + group.length, 0);
  });

  suspiciousCount = computed(() => {
    const groups = this.service.groupedItems();
    const suspiciousGroup = groups.find((g) => g.id === 'suspicious');
    return suspiciousGroup ? suspiciousGroup.items.length : 0;
  });

  constructor() {
    effect(() => {
      const results = this.service.automatedResults();
      const currentColors = this.automatedResultColors();

      if (results && results.length > 0) {
        if (currentColors.length !== results.length) {
          this.automatedResultColors.set(results.map(() => this.getRandomHexColor()));
        }
      } else if (!results && currentColors.length > 0) {
        this.automatedResultColors.set([]);
      }
    });
  }

  getLimit(groupId: string): number {
    return this.groupDisplayLimits().get(groupId) || this.INITIAL_DISPLAY_LIMIT;
  }

  increaseLimit(groupId: string, amount: number = 100) {
    this.groupDisplayLimits.update((map) => {
      const newMap = new Map(map);
      const current = newMap.get(groupId) || this.INITIAL_DISPLAY_LIMIT;
      newMap.set(groupId, current + amount);
      return newMap;
    });
  }

  setMode(newMode: 'simple' | 'advanced') {
    const currentMode = this.service.mode();
    if (currentMode === newMode) return;

    let hasData = false;
    if (currentMode === 'simple') {
      hasData = !!this.service.automatedResults();
    } else {
      const tabs = this.service.tabs();
      hasData = tabs.length > 1 || tabs.some((t) => t.items.length > 0);
    }

    if (hasData) {
      if (
        !confirm(
          'Switching modes will clear your current workspace data. Are you sure you want to proceed?',
        )
      ) {
        return;
      }
    }

    this.service.mode.set(newMode);
    this.service.resetState();
    this.automatedResultColors.set([]);
    this.groupDisplayLimits.set(new Map());
  }

  startAutomatedTrace() {
    const inputValue = this.batchInputValue;
    if (!inputValue.trim()) return;

    if (this.service.automatedResults()) {
      if (
        !confirm('Starting a new trace will clear the current results. Do you want to continue?')
      ) {
        return;
      }
      this.clearAutomatedResults();
      this.batchInputValue = inputValue;
    }

    const rawValues = inputValue.split(/[\n, ]+/).filter((v) => v.trim());
    if (rawValues.length === 0) return;

    this.isLoading.set(true);
    this.service.automateOutputMerging(rawValues).subscribe({
      next: (result) => {
        this.service.automatedResults.set(result);
        this.automatedResultColors.set(result.map(() => this.getRandomHexColor()));
        this.batchInputValue = '';
        this.isLoading.set(false);
        this.groupDisplayLimits.set(new Map());
        this.automatedTraceComplete.emit({
          result,
          colors: this.automatedResultColors(),
        });
      },
      error: (err) => {
        console.error('Error automating trace:', err);
        this.isLoading.set(false);
      },
    });
  }

  clearAutomatedResults() {
    this.service.automatedResults.set(null);
    this.automatedResultColors.set([]);
    this.batchInputValue = '';
    this.groupDisplayLimits.set(new Map());
    this.clearAutomatedTrace.emit();
  }

  toggle() {
    this.isOpen.update((v) => !v);
  }

  toggleGroupForm() {
    this.showNewGroupForm.update((v) => !v);
  }

  toggleGroupCollapse(categoryId: string) {
    this.collapsedGroups.update((currentSet) => {
      const newSet = new Set(currentSet);
      if (newSet.has(categoryId)) {
        newSet.delete(categoryId);
      } else {
        newSet.add(categoryId);
      }
      return newSet;
    });
  }

  isCollapsed(categoryId: string): boolean {
    return this.collapsedGroups().has(categoryId);
  }

  trackByItem(index: number, item: ClipboardItem): string {
    return item.id;
  }

  trackByGroup(index: number, group: any): string {
    return group.id;
  }

  createGroup() {
    if (!this.newGroupName.trim()) return;
    const newId = this.service.addCategory(this.newGroupName, this.newGroupColor);

    this.newGroupName = '';
    this.showNewGroupForm.set(false);
    this.selectedCategoryId = newId;
  }

  startEditGroup(event: Event, group: any) {
    event.stopPropagation();
    this.editingGroupId.set(group.id);
    this.tempGroupName = group.name;
  }

  saveEditGroup() {
    const id = this.editingGroupId();
    if (id && this.tempGroupName.trim()) {
      this.service.updateCategoryName(id, this.tempGroupName);
    }
    this.cancelEditGroup();
  }

  cancelEditGroup() {
    this.editingGroupId.set(null);
    this.tempGroupName = '';
  }

  handleEditKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      this.saveEditGroup();
    } else if (event.key === 'Escape') {
      this.cancelEditGroup();
    }
    event.stopPropagation();
  }

  addTab() {
    const nextIndex = this.service.tabs().length + 1;
    this.service.addTab(`Tab ${nextIndex}`);
  }

  startEditTab(tab: HashboardTab, event?: Event) {
    event?.stopPropagation();
    this.editingTabId.set(tab.id);
    this.tempTabName = tab.name;

    setTimeout(() => {
      const inputElement = this.elementRef.nativeElement.querySelector('.tab-name-edit');
      if (inputElement) {
        inputElement.focus();
        inputElement.select();
      }
    }, 0);
  }

  saveEditTab() {
    const id = this.editingTabId();
    if (!id) {
      this.cancelEditTab();
      return;
    }

    let finalName = this.tempTabName.trim();

    if (!finalName) {
      const tabIndex = this.service.tabs().findIndex((t) => t.id === id);
      finalName = `Tab ${tabIndex + 1}`;
    }

    this.service.renameTab(id, finalName);
    this.cancelEditTab();
  }

  cancelEditTab() {
    this.editingTabId.set(null);
    this.tempTabName = '';
  }

  handleTabEditKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      this.saveEditTab();
    } else if (event.key === 'Escape') {
      this.cancelEditTab();
    }
    event.stopPropagation();
  }

  copyAllHashes() {
    const items = this.service.items();
    if (items.length === 0) return;

    const uniqueHashes = [...new Set(items.map((item) => item.value))];
    const hashesString = uniqueHashes.join(', ');

    if (!hashesString) return;

    navigator.clipboard.writeText(hashesString).then(
      () => {
        this.justCopiedAll.set(true);
        setTimeout(() => {
          this.justCopiedAll.set(false);
        }, 2000);
      },
      (err) => {
        console.error('Failed to copy all hashes: ', err);
      },
    );
  }

  toggleHighlightGroup(groupId: string, event: MouseEvent) {
    event.stopPropagation();
    this.service.toggleHighlightGroup(groupId);
  }

  toggleActiveTabHighlight(event: MouseEvent) {
    event.stopPropagation();
    const activeTabId = this.service.activeTabId();
    if (activeTabId) {
      this.service.toggleHighlightTab(activeTabId);
    }
  }

  copyGroupHashes(group: any, event: Event) {
    event.stopPropagation();
    if (!group.items || group.items.length === 0) return;

    const hashes = group.items.map((item: ClipboardItem) => item.value).join(', ');
    if (!hashes) return;

    navigator.clipboard.writeText(hashes).then(
      () => {
        this.justCopiedGroupId.set(group.id);
        setTimeout(() => {
          if (this.justCopiedGroupId() === group.id) {
            this.justCopiedGroupId.set(null);
          }
        }, 2000);
      },
      (err) => {
        console.error('Failed to copy hashes: ', err);
      },
    );
  }

  getTxGroupHashes(group: Transaction[]): string {
    return group.map((tx) => tx.tx_hash).join(', ');
  }

  copyText(text: string, event?: Event, groupId?: string) {
    event?.stopPropagation();
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => {
        if (groupId) {
          this.justCopiedGroupId.set(groupId);
          setTimeout(() => {
            if (this.justCopiedGroupId() === groupId) {
              this.justCopiedGroupId.set(null);
            }
          }, 2000);
        }
      },
      (err) => {
        console.error('Failed to copy text: ', err);
      },
    );
  }

  deleteTab(tabId: string, event: Event) {
    event.stopPropagation();
    event.preventDefault();

    if (this.service.tabs().length <= 1) {
      alert('You cannot delete the last workspace.');
      return;
    }

    if (confirm('Are you sure you want to delete this workspace and all its items?')) {
      this.service.deleteTab(tabId);
    }
  }

  importBatch() {
    if (!this.batchInputValue.trim()) return;
    const rawValues = this.batchInputValue.split(/[\n, ]+/).filter((v) => v.trim());
    if (rawValues.length === 0) return;

    this.isLoading.set(true);

    if (this.addMode === 'indices') {
      const indices = [...new Set(rawValues.map((v) => parseInt(v, 10)).filter((v) => !isNaN(v)))];
      const indicesStr = indices.toString();
      this.service.getBatchIndices(indicesStr).subscribe({
        next: (map: OutputTransactionsMap) => {
          const currentCategories = this.service.categories();
          const currentItems = this.service.items();

          Object.entries(map).forEach(([outputIndex, txHashes]) => {
            if (!txHashes || txHashes.length === 0) return;

            const categoryName = `Output Index ${outputIndex}`;

            const existingCategory = currentCategories.find((c) => c.name === categoryName);

            let targetCategoryId: string;

            if (existingCategory) {
              targetCategoryId = existingCategory.id;

              const existingValuesInGroup = new Set(
                currentItems.filter((i) => i.categoryId === targetCategoryId).map((i) => i.value),
              );

              txHashes = txHashes.filter((hash) => !existingValuesInGroup.has(hash));

              if (txHashes.length === 0) return;
            } else {
              targetCategoryId = this.service.addCategory(categoryName, this.getRandomHexColor());
            }

            this.service.addItems(txHashes, targetCategoryId, `Linked to Output ${outputIndex}`);
          });
          this.isLoading.set(false);
        },
        error: (err) => {
          console.error('Error fetching tx_hashes', err);
          this.isLoading.set(false);
        },
      });
    } else {
      // hashes
      const hashes = [...new Set(rawValues)].toString();
      this.service.getBatchTxs(hashes).subscribe({
        next: (map: OutputTransactionsMap) => {
          const currentCategories = this.service.categories();
          const currentItems = this.service.items();

          Object.entries(map).forEach(([outputIndex, txHashes]) => {
            if (!txHashes || txHashes.length === 0) return;

            const categoryName = `Output Index ${outputIndex}`;

            const existingCategory = currentCategories.find((c) => c.name === categoryName);

            let targetCategoryId: string;

            if (existingCategory) {
              targetCategoryId = existingCategory.id;

              const existingValuesInGroup = new Set(
                currentItems.filter((i) => i.categoryId === targetCategoryId).map((i) => i.value),
              );

              txHashes = txHashes.filter((hash) => !existingValuesInGroup.has(hash));

              if (txHashes.length === 0) return;
            } else {
              targetCategoryId = this.service.addCategory(categoryName, this.getRandomHexColor());
            }

            this.service.addItems(txHashes, targetCategoryId, `Linked to Output ${outputIndex}`);
          });
          this.isLoading.set(false);
        },
        error: (err) => {
          console.error('Error fetching tx_hashes', err);
          this.isLoading.set(false);
        },
      });
    }
    this.batchInputValue = '';
  }

  handleBatchKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.importBatch();
    }
  }

  importFromInput() {
    if (!this.inputValue.trim()) return;

    const rawValues = this.inputValue.split(/[\n, ]+/);

    this.service.addItems(rawValues, this.selectedCategoryId);
    this.inputValue = '';
  }

  handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.importFromInput();
    }
  }

  public getRandomHexColor(): string {
    const h = Math.floor(Math.random() * 360);
    const s = 50 + Math.random() * 50;
    const l = 30 + Math.random() * 55;

    const s_norm = s / 100;
    const l_norm = l / 100;
    const c = (1 - Math.abs(2 * l_norm - 1)) * s_norm;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l_norm - c / 2;
    let r = 0,
      g = 0,
      b = 0;

    if (0 <= h && h < 60) {
      r = c;
      g = x;
      b = 0;
    } else if (60 <= h && h < 120) {
      r = x;
      g = c;
      b = 0;
    } else if (120 <= h && h < 180) {
      r = 0;
      g = c;
      b = x;
    } else if (180 <= h && h < 240) {
      r = 0;
      g = x;
      b = c;
    } else if (240 <= h && h < 300) {
      r = x;
      g = 0;
      b = c;
    } else if (300 <= h && h < 360) {
      r = c;
      g = 0;
      b = x;
    }

    const toHex = (c_val: number) => {
      const hex = Math.round((c_val + m) * 255).toString(16);
      return hex.length == 1 ? '0' + hex : hex;
    };

    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  @HostListener('document:click', ['$event'])
  onClickOutside(event: MouseEvent) {
    const clickedInside = this.elementRef.nativeElement.contains(event.target);
    if (!clickedInside) {
      this.isOpen.set(false);
    }
  }
}
