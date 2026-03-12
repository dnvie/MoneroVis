import { Injectable, signal, computed, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { OutputTransactionsMap } from '../data/decoy_transaction';
import { MergingResult } from '../data/merging_result';

export interface Category {
  id: string;
  name: string;
  color: string;
}

export interface ClipboardItem {
  id: string;
  value: string;
  note: string;
  categoryId: string;
  timestamp: number;
}

export interface HashboardTab {
  id: string;
  name: string;
  categories: Category[];
  items: ClipboardItem[];
}

const baseUrl = 'https://api.monerovis.workers.dev';
const backendUrl = 'https://api.monerovis.com';

@Injectable({
  providedIn: 'root',
})
export class ClipboardService {
  private readonly GROUP_DEFAULT_ID = 'default';
  private tabsSignal = signal<HashboardTab[]>([]);
  private activeTabIdSignal = signal<string>('');
  private highlightedGroupIdsSignal = signal<Set<string>>(new Set());
  private highlightedTabIdsSignal = signal<Set<string>>(new Set());

  public mode = signal<'simple' | 'advanced'>('simple');
  public automatedResults = signal<MergingResult | null>(null);

  constructor(private http: HttpClient) {
    this.initializeDefaultState();

    try {
      const savedTabs = localStorage.getItem('monerovis_advanced_tabs');
      const savedActiveTabId = localStorage.getItem('monerovis_active_tab_id');

      if (savedTabs) {
        const tabs = JSON.parse(savedTabs);
        if (Array.isArray(tabs) && tabs.length > 0) {
          this.tabsSignal.set(tabs);

          const isValidId = tabs.some((t) => t.id === savedActiveTabId);
          if (savedActiveTabId && isValidId) {
            this.activeTabIdSignal.set(savedActiveTabId);
          } else {
            this.activeTabIdSignal.set(tabs[0].id);
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load advanced state from localStorage', e);
    }

    try {
      const savedAutoTrace = localStorage.getItem('monerovis_auto_trace');
      if (savedAutoTrace) {
        this.automatedResults.set(JSON.parse(savedAutoTrace));
      }
    } catch (e) {
      console.warn('Failed to load auto trace from localStorage', e);
    }

    effect(() => {
      const results = this.automatedResults();
      try {
        if (results) {
          localStorage.setItem('monerovis_auto_trace', JSON.stringify(results));
        } else {
          localStorage.removeItem('monerovis_auto_trace');
        }
      } catch (e) {
        console.error('Failed to save auto trace to localStorage', e);
      }
    });

    effect(() => {
      const tabs = this.tabsSignal();
      const activeTabId = this.activeTabIdSignal();
      try {
        localStorage.setItem('monerovis_advanced_tabs', JSON.stringify(tabs));
        localStorage.setItem('monerovis_active_tab_id', activeTabId);
      } catch (e) {
        console.error('Failed to save advanced state to localStorage', e);
      }
    });
  }

  private initializeDefaultState() {
    const initialTabId = crypto.randomUUID();
    this.tabsSignal.set([
      {
        id: initialTabId,
        name: 'Tab 1',
        categories: [{ id: this.GROUP_DEFAULT_ID, name: 'General', color: '#6c757d' }],
        items: [],
      },
    ]);
    this.activeTabIdSignal.set(initialTabId);
    this.highlightedGroupIdsSignal.set(new Set());
    this.highlightedTabIdsSignal.set(new Set());
  }

  public resetState() {
    this.initializeDefaultState();
    this.automatedResults.set(null);
  }

  public readonly tabs = this.tabsSignal.asReadonly();
  public readonly activeTabId = this.activeTabIdSignal.asReadonly();
  public readonly highlightedGroupIds = this.highlightedGroupIdsSignal.asReadonly();
  public readonly highlightedTabIds = this.highlightedTabIdsSignal.asReadonly();

  public readonly simpleModeHashes = computed(() => {
    const results = this.automatedResults();
    if (!results) return new Set<string>();
    const hashes = new Set<string>();
    results.forEach((round) => {
      round.forEach((tx) => hashes.add(tx.tx_hash));
    });
    return hashes;
  });

  public readonly activeTab = computed(() => {
    const tabs = this.tabs();
    const activeId = this.activeTabId();
    return tabs.find((t) => t.id === activeId);
  });

  public readonly allHashCounts = computed(() => {
    const allItems = this.tabsSignal().flatMap((tab) => tab.items);
    const valueCounts = new Map<string, number>();
    allItems.forEach((item) => {
      valueCounts.set(item.value, (valueCounts.get(item.value) || 0) + 1);
    });
    return valueCounts;
  });

  public readonly allSuspiciousHashes = computed(() => {
    const counts = this.allHashCounts();
    const suspicious = new Set<string>();
    for (const [hash, count] of counts.entries()) {
      if (count > 1) {
        suspicious.add(hash);
      }
    }
    return suspicious;
  });

  public readonly highlightedHashes = computed(() => {
    const highlightedGroupIds = this.highlightedGroupIds();
    const highlightedTabIds = this.highlightedTabIds();
    const tabs = this.tabsSignal();

    if (highlightedGroupIds.size === 0 && highlightedTabIds.size === 0) {
      return new Set<string>();
    }

    const hashes = new Set<string>();

    tabs.forEach((tab) => {
      tab.items.forEach((item) => {
        if (highlightedGroupIds.has(item.categoryId)) {
          hashes.add(item.value);
        }
      });
    });

    tabs.forEach((tab) => {
      if (highlightedTabIds.has(tab.id)) {
        tab.items.forEach((item) => hashes.add(item.value));
      }
    });

    return hashes;
  });

  public readonly allHighlightedHashes = computed(() => {
    const suspicious = this.allSuspiciousHashes();
    const highlighted = this.highlightedHashes();
    return new Set([...suspicious, ...highlighted]);
  });

  public readonly categories = computed(() => this.activeTab()?.categories || []);
  public readonly items = computed(() => this.activeTab()?.items || []);
  public readonly totalCount = computed(() => this.items().length);

  public readonly hashCounts = computed(() => {
    const items = this.items();
    const valueCounts = new Map<string, number>();
    items.forEach((item) => {
      valueCounts.set(item.value, (valueCounts.get(item.value) || 0) + 1);
    });
    return valueCounts;
  });

  public readonly groupedItems = computed(() => {
    const cats = this.categories();
    const allItems = this.items();
    const counts = this.hashCounts();

    const suspiciousItems: ClipboardItem[] = [];
    const processedDuplicates = new Set<string>();

    for (const item of allItems) {
      const isDuplicate = (counts.get(item.value) || 0) > 1;
      if (isDuplicate && !processedDuplicates.has(item.value)) {
        suspiciousItems.push({
          ...item,
          id: `suspicious-${item.value}`,
          note: `${counts.get(item.value)} occurrences found`,
          categoryId: 'suspicious',
        });
        processedDuplicates.add(item.value);
      }
    }

    const regularGroups = cats.map((cat) => ({
      ...cat,
      items: allItems.filter((item) => item.categoryId === cat.id),
    }));

    if (suspiciousItems.length > 0) {
      const suspiciousGroup = {
        id: 'suspicious',
        name: 'Suspicious',
        color: '#ec312c', // Red color
        items: suspiciousItems,
      };
      return [suspiciousGroup, ...regularGroups];
    }

    return regularGroups;
  });

  addTab(name: string): string {
    const newTabId = crypto.randomUUID();
    const newTab: HashboardTab = {
      id: newTabId,
      name: name.trim(),
      categories: [{ id: this.GROUP_DEFAULT_ID, name: 'General', color: '#6c757d' }],
      items: [],
    };
    this.tabsSignal.update((tabs) => [...tabs, newTab]);
    this.activeTabIdSignal.set(newTabId);
    return newTabId;
  }

  switchToTab(tabId: string) {
    this.activeTabIdSignal.set(tabId);
  }

  renameTab(tabId: string, newName: string) {
    if (!newName.trim()) return;
    this.tabsSignal.update((tabs) =>
      tabs.map((tab) => (tab.id === tabId ? { ...tab, name: newName.trim() } : tab)),
    );
  }

  deleteTab(tabId: string) {
    this.highlightedTabIdsSignal.update((set) => {
      const newSet = new Set(set);
      newSet.delete(tabId);
      return newSet;
    });
    this.tabsSignal.update((tabs) => {
      const newTabs = tabs.filter((t) => t.id !== tabId);
      if (newTabs.length === 0) {
        this.initializeDefaultState();
        return this.tabsSignal();
      } else if (this.activeTabIdSignal() === tabId) {
        this.activeTabIdSignal.set(newTabs[0].id);
      }
      return newTabs;
    });
  }

  private updateActiveTab(updater: (activeTab: HashboardTab) => HashboardTab) {
    const activeId = this.activeTabId();
    this.tabsSignal.update((tabs) => tabs.map((tab) => (tab.id === activeId ? updater(tab) : tab)));
  }

  toggleHighlightGroup(groupId: string) {
    this.highlightedGroupIdsSignal.update((set) => {
      const newSet = new Set(set);
      if (newSet.has(groupId)) {
        newSet.delete(groupId);
      } else {
        newSet.add(groupId);
      }
      return newSet;
    });
  }

  toggleHighlightTab(tabId: string) {
    this.highlightedTabIdsSignal.update((set) => {
      const newSet = new Set(set);
      if (newSet.has(tabId)) {
        newSet.delete(tabId);
      } else {
        newSet.add(tabId);
      }
      return newSet;
    });
  }

  addCategory(name: string, color: string): string {
    const newCat: Category = { id: crypto.randomUUID(), name: name.trim(), color };
    this.updateActiveTab((tab) => ({
      ...tab,
      categories: [...tab.categories, newCat],
    }));
    return newCat.id;
  }

  deleteCategory(id: string) {
    if (id === 'default') return;
    this.updateActiveTab((tab) => ({
      ...tab,
      items: tab.items.filter((i) => i.categoryId !== id),
      categories: tab.categories.filter((cat) => cat.id !== id),
    }));
  }

  addItems(values: string[], categoryId: string, note: string = '') {
    const newItems: ClipboardItem[] = values
      .filter((v) => !!v && v.trim().length > 0)
      .map((value) => ({
        id: crypto.randomUUID(),
        value: value.trim(),
        note: note,
        categoryId: categoryId,
        timestamp: Date.now(),
      }));
    if (newItems.length === 0) return;
    this.updateActiveTab((tab) => ({
      ...tab,
      items: [...newItems, ...tab.items],
    }));
  }

  updateItemNote(id: string, newNote: string) {
    this.updateActiveTab((tab) => ({
      ...tab,
      items: tab.items.map((i) => (i.id === id ? { ...i, note: newNote } : i)),
    }));
  }

  updateCategoryName(id: string, newName: string) {
    if (!newName.trim()) return;
    this.updateActiveTab((tab) => ({
      ...tab,
      categories: tab.categories.map((c) => (c.id === id ? { ...c, name: newName.trim() } : c)),
    }));
  }

  removeItem(id: string) {
    this.updateActiveTab((tab) => ({
      ...tab,
      items: tab.items.filter((i) => i.id !== id),
    }));
  }

  clearAll() {
    this.updateActiveTab((tab) => ({
      ...tab,
      items: [],
      categories: [{ id: this.GROUP_DEFAULT_ID, name: 'General', color: '#6c757d' }],
    }));
  }

  getBatchIndices(indices: string): Observable<OutputTransactionsMap> {
    return this.http.get<OutputTransactionsMap>(`${baseUrl}/batchDecoyTxs?indices=${indices}`);
  }

  getBatchTxs(hashes: string): Observable<OutputTransactionsMap> {
    return this.http.get<OutputTransactionsMap>(`${baseUrl}/batchTxs?hashes=${hashes}`);
  }

  automateOutputMerging(hashes: string[]): Observable<MergingResult> {
    return this.http.post<MergingResult>(`${backendUrl}/automateOutputMerging`, {
      hashes,
    });
  }
}
