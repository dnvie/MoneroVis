import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  Input,
  ViewChild,
  ViewEncapsulation,
  ChangeDetectorRef,
  HostListener,
  signal,
  inject,
  OnDestroy,
  effect,
  Output,
  EventEmitter,
  OnChanges,
  SimpleChanges,
  WritableSignal,
} from '@angular/core';
import { Router } from '@angular/router';
import * as d3 from 'd3';
import { TransactionService } from '../../service/transaction.service';
import { Transaction } from '../../data/transaction';
import { ClipboardService } from '../../service/clipboard.service';
import { SidebarService } from '../../service/sidebar.service';
import { ModalService } from '../../service/modal.service';
import { DecoyService } from '../../service/decoy.service';
import { MergingResult } from '../../data/merging_result';

const RING_WIDTH_PIXELS = 250;
const MIN_RADIUS = 25;
const MAX_RADIUS = 60;
const MIN_THICKNESS = 5;
const MAX_THICKNESS = 20;
const OUTER_EDGE_BUFFER = 5;

const LEGACY_MIN_RADIUS = 2;
const LEGACY_MAX_RADIUS = 12;

type GraphMode = 'ring' | 'legacy';

interface GraphInstance {
  id: string;
  inputRoot: d3.HierarchyNode<any>;
  outputRoot: d3.HierarchyNode<any>;
  offsetX: number;
  offsetY: number;
  expandedNodeIds: Set<string>;
  extraConnectors?: any[];
  rotationEnabled?: boolean;
  connector: {
    originGraphId: string;
    originNodeId: string;
    targetNode: any;
    originX?: number;
    originY?: number;
    originAngle?: number;
  } | null;
}

interface GraphSaveFile {
  timestamp: string;
  mode: GraphMode;
  labels: { [id: string]: { text: string; color: string } | string };
  highlightedAddress: string | null;
  graphs: {
    tx: Transaction;
    connector: any;
    extraConnectors?: any[];
    id: string;
    rotationEnabled?: boolean;
    expandedNodeIds: string[];
  }[];
}

@Component({
  selector: 'app-transaction-graph',
  templateUrl: './transaction-graph.html',
  styleUrls: ['./transaction-graph.scss'],
  encapsulation: ViewEncapsulation.None,
  imports: [CommonModule],
  standalone: true,
})
export class TransactionGraph implements OnDestroy, OnChanges {
  @ViewChild('treeContainer', { static: true }) private treeContainer!: ElementRef;
  @ViewChild('tooltip', { static: true }) private tooltip!: ElementRef;

  @Input() initialTransaction: Transaction | null = null;
  @Input() highlightedAddress: string | null = null;
  @Input() fillParent: boolean = false;
  @Input() isSidebar: boolean = false;

  @Output() navigateToDecoy = new EventEmitter<void>();

  public isGraphLoading = signal(false);
  public isFullscreen = signal(false);
  public isEmpty = signal(true);
  public currentMode: WritableSignal<GraphMode> = signal('ring');

  public mergingResults: MergingResult | null = null;
  private txLabels: Map<string, { text: string; color: string }> = new Map();

  private graphs: GraphInstance[] = [];
  private preservedZoom: any = null;
  private zoomBehavior: any;
  private svgSelection: any;
  private containerSelection: any;
  private globalMaxDecoyCount = 1;
  private initialContainerHeight: number | null = null;
  private currentActiveHash: string = '';

  private clipboardService = inject(ClipboardService);
  private transactionService = inject(TransactionService);
  private sidebarService = inject(SidebarService);
  private modalService = inject(ModalService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private decoyService = inject(DecoyService);

  private radiusScale = d3.scaleLinear().range([MIN_RADIUS, MAX_RADIUS]);
  private thicknessScale = d3.scaleLinear().range([MIN_THICKNESS, MAX_THICKNESS]);
  private pieGenerator = d3.pie<any>().padAngle(0.04).value(1).sort(null);

  private mainArcGenerator = d3
    .arc<any>()
    .innerRadius((d: any) => d.data.plotRadius)
    .outerRadius((d: any) => d.data.plotRadius + d.data.plotThickness)
    .cornerRadius(3);

  private bgArcGenerator = d3
    .arc<any>()
    .innerRadius(MIN_RADIUS)
    .outerRadius(MAX_RADIUS + MAX_THICKNESS + OUTER_EDGE_BUFFER)
    .cornerRadius(3);

  constructor() {
    const savedMode = localStorage.getItem('txGraphMode') as GraphMode;
    if (this.isSidebar) {
      this.currentMode.set('legacy');
    } else {
      const savedMode = localStorage.getItem('txGraphMode') as GraphMode;
      if (savedMode === 'ring' || savedMode === 'legacy') {
        this.currentMode.set(savedMode);
      }
    }

    effect(() => {
      this.clipboardService.allSuspiciousHashes();
      this.clipboardService.highlightedHashes();

      if (this.svgSelection) {
        this.updateChart();
      }
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['initialTransaction']) {
      const newData = changes['initialTransaction'].currentValue as Transaction;

      if (!newData) {
        return;
      }

      const newHash = newData.tx_hash;
      const isAlreadyInGraph = this.graphs.some((g) => g.id === newHash);

      if (isAlreadyInGraph) {
        this.currentActiveHash = newHash;
      } else {
        this.processAndRenderTransaction(newData);
      }
    }
  }

  @HostListener('window:resize')
  onResize() {
    if (this.svgSelection && this.treeContainer) {
      this.updateChart();
    }
  }

  toggleFullscreen() {
    this.isFullscreen.update((v) => {
      const newValue = !v;
      if (!this.fillParent) {
        this.sidebarService.isAnyGraphFullscreen.set(newValue);
      }
      return newValue;
    });
    setTimeout(() => {
      this.updateChart();
    }, 100);
  }

  toggleLegend() {
    if (this.currentMode() === 'ring') {
      let hasAge0 = false;
      for (const graph of this.graphs) {
        const leaves = graph.inputRoot.leaves();
        for (const leaf of leaves) {
          if (leaf.data.ring_members) {
            for (const rm of leaf.data.ring_members) {
              if (rm.age_delta <= 0) {
                hasAge0 = true;
                break;
              }
            }
          }
          if (hasAge0) break;
        }
        if (hasAge0) break;
      }
      this.modalService.open('legend', { hasAge0, graphMode: this.currentMode() });
    } else {
      this.modalService.open('legend', { graphMode: this.currentMode() });
    }
  }

  switchMode(newMode: GraphMode) {
    if (this.currentMode() === newMode) {
      return;
    }

    const graphsToRestore = this.graphs.map((g) => ({
      tx: g.inputRoot.data.raw,
      connector: g.connector,
      extraConnectors: g.extraConnectors,
      id: g.id,
      rotationEnabled: g.rotationEnabled,
    }));

    if (this.svgSelection && this.svgSelection.node()) {
      this.preservedZoom = d3.zoomTransform(this.svgSelection.node() as Element);
    } else {
      this.preservedZoom = null;
    }

    this.currentMode.set(newMode);
    localStorage.setItem('txGraphMode', newMode);

    this.clearChart();
    this.globalMaxDecoyCount = 1;

    if (graphsToRestore.length > 0) {
      const rootInfo = graphsToRestore[0];
      const mappedRoot =
        newMode === 'ring'
          ? this.mapApiToD3_Ring(rootInfo.tx)
          : this.mapApiToD3_Legacy(rootInfo.tx);

      if (mappedRoot) {
        this.addTransactionToGraph(mappedRoot, null, false, rootInfo.rotationEnabled);
      }

      for (let i = 1; i < graphsToRestore.length; i++) {
        const gInfo = graphsToRestore[i];
        if (!gInfo.connector) continue;

        const parentId = gInfo.connector.originGraphId;
        const parentGraph = this.graphs.find((g) => g.id === parentId);

        if (parentGraph) {
          const originNodeId = gInfo.connector.originNodeId;
          const context = this.findRingMemberContext(parentGraph, originNodeId);

          if (context) {
            parentGraph.expandedNodeIds.add(originNodeId);

            if (newMode === 'ring') {
              this.prepareGraphData_Ring(parentGraph);
            }

            const alignTarget = this.generateAlignTarget(parentGraph, context);
            if (alignTarget) {
              const mappedTx =
                newMode === 'ring'
                  ? this.mapApiToD3_Ring(gInfo.tx)
                  : this.mapApiToD3_Legacy(gInfo.tx);
              if (mappedTx) {
                this.addTransactionToGraph(mappedTx, alignTarget, false, gInfo.rotationEnabled);
              }
            }
          }
        }
      }

      this.restoreExtraConnectors(graphsToRestore);

      this.updateChart();
    } else if (this.initialTransaction) {
      this.processAndRenderTransaction(this.initialTransaction);
    }

    if (this.isSidebar && this.mergingResults) {
      this.visualizeTrace(this.mergingResults);
    }
  }

  private findRingMemberContext(
    graph: GraphInstance,
    rmId: string,
  ): { d3Node: any; ringMemberData: any } | null {
    if (this.currentMode() === 'ring') {
      const leaf = graph.inputRoot
        .leaves()
        .find((node: any) => node.data.ring_members?.some((rm: any) => rm.id === rmId));
      if (leaf) {
        const rm = leaf.data.ring_members.find((rm: any) => rm.id === rmId);
        return { d3Node: leaf, ringMemberData: rm };
      }
    } else {
      const node = graph.inputRoot.descendants().find((node: any) => node.data.id === rmId);
      if (node) {
        return { d3Node: node, ringMemberData: node.data };
      }
    }
    return null;
  }

  private prepareGraphData_Ring(graph: GraphInstance) {
    graph.inputRoot.leaves().forEach((node: any) => {
      if (node.data.type === 'input') {
        const members = node.data.ring_members;
        const minAge = d3.min(members, (d: any) => d.age_delta as number) as unknown as number;
        const maxAge = d3.max(members, (d: any) => d.age_delta as number) as unknown as number;
        const maxCount = d3.max(members, (d: any) => d.decoy_count as number) as unknown as number;

        this.radiusScale.domain([minAge || 0, maxAge || 0]);
        this.thicknessScale.domain([0, maxCount || 1]);

        members.forEach((m: any) => {
          m.plotRadius = this.radiusScale(m.age_delta);
          m.plotThickness = this.thicknessScale(m.decoy_count);
        });
        const arcs = this.pieGenerator(members);

        if (graph.rotationEnabled) {
          let firstExpandedInRing = null;
          for (const id of graph.expandedNodeIds) {
            if (members.some((m: any) => m.id === id)) {
              firstExpandedInRing = id;
              break;
            }
          }

          if (firstExpandedInRing) {
            const anchorArc = arcs.find((a: any) => a.data.id === firstExpandedInRing);
            if (anchorArc) {
              const currentMid = (anchorArc.startAngle + anchorArc.endAngle) / 2;
              const target = -Math.PI / 2;
              const rotation = target - currentMid;
              arcs.forEach((a: any) => {
                a.startAngle += rotation;
                a.endAngle += rotation;
              });
            }
          }
        }
        node.data.arcs = arcs;
      }
    });
  }

  private generateAlignTarget(graph: GraphInstance, context: { d3Node: any; ringMemberData: any }) {
    const mode = this.currentMode();
    if (mode === 'ring') {
      const { d3Node, ringMemberData } = context;
      const centerX = d3Node.y + graph.offsetX;
      const centerY = d3Node.x + graph.offsetY;
      const r = MAX_RADIUS + MAX_THICKNESS + OUTER_EDGE_BUFFER;

      const arc = d3Node.data.arcs?.find((a: any) => a.data.id === ringMemberData.id);
      if (!arc) return null;

      const anchor = this.getOuterEdgePoint(centerX, centerY, arc.startAngle, arc.endAngle, r);
      const targetAngle = (arc.startAngle + arc.endAngle) / 2;

      return {
        absoluteX: anchor.x,
        absoluteY: anchor.y,
        centerX: centerX,
        data: ringMemberData,
        originGraphId: graph.id,
        angle: targetAngle,
      };
    } else {
      const { d3Node, ringMemberData } = context;
      return {
        absoluteX: d3Node.y + graph.offsetX,
        absoluteY: d3Node.x + graph.offsetY,
        graphCenterY: graph.offsetY,
        parentOffsetX: graph.offsetX,
        parent: d3Node.parent,
        data: d3Node.data,
        originGraphId: graph.id,
      };
    }
  }

  private findOutputNodeByStealth(graph: GraphInstance, stealth: string) {
    return graph.outputRoot.leaves().find((n: any) => n.data.stealth_address === stealth);
  }

  private restoreExtraConnectors(oldGraphs: any[]) {
    for (const gInfo of oldGraphs) {
      if (gInfo.extraConnectors) {
        const newGraph = this.graphs.find((ng) => ng.id === gInfo.id);
        if (!newGraph) continue;

        for (const ec of gInfo.extraConnectors) {
          const targetGraphId = ec.targetGraph.id;
          const targetGraph = this.graphs.find((ng) => ng.id === targetGraphId);

          if (targetGraph) {
            const context = this.findRingMemberContext(newGraph, ec.originNodeData.id);
            const targetNode = this.findOutputNodeByStealth(
              targetGraph,
              ec.targetNode.data.stealth_address,
            );

            if (context && targetNode) {
              if (!newGraph.extraConnectors) newGraph.extraConnectors = [];
              newGraph.extraConnectors.push({
                originNodeData: context.ringMemberData,
                originNode: context.d3Node,
                targetNode: targetNode,
                targetGraph: targetGraph,
              });
              newGraph.expandedNodeIds.add(context.ringMemberData.id);
            }
          }
        }
      }
    }
  }

  public clearChart(): void {
    this.hideTooltip();
    if (this.treeContainer && this.treeContainer.nativeElement) {
      d3.select(this.treeContainer.nativeElement).selectAll('*').remove();
    }
    this.graphs = [];
    this.svgSelection = null;
    this.containerSelection = null;
    this.initialContainerHeight = null;
    this.globalMaxDecoyCount = 1;
    this.isEmpty.set(true);
  }

  public processAndRenderTransaction(data: Transaction): void {
    if (data && data.tx_hash) {
      this.currentActiveHash = data.tx_hash;
    }
    this.globalMaxDecoyCount = 1;

    requestAnimationFrame(() => {
      if (this.treeContainer && this.treeContainer.nativeElement) {
        this.clearChart();
        const mappedData =
          this.currentMode() === 'ring' ? this.mapApiToD3_Ring(data) : this.mapApiToD3_Legacy(data);

        if (mappedData) {
          this.addTransactionToGraph(mappedData);
        }
      }
    });
  }

  public addTransaction(tx: Transaction, alignTarget: any = null, expandAll: boolean = false) {
    const mappedData =
      this.currentMode() === 'ring' ? this.mapApiToD3_Ring(tx) : this.mapApiToD3_Legacy(tx);

    if (mappedData) {
      this.addTransactionToGraph(mappedData, alignTarget, expandAll);
    }
  }

  private addTransactionToGraph(
    txData: any,
    alignTarget: any = null,
    expandAll: boolean = false,
    rotationEnabled: boolean = false,
  ): void {
    this.isEmpty.set(false);
    if (this.currentMode() === 'ring') {
      this.addTransactionToGraph_Ring(txData, alignTarget, expandAll, rotationEnabled);
    } else {
      this.addTransactionToGraph_Legacy(txData, alignTarget, expandAll);
    }
  }

  public updateChart(): void {
    if (this.currentMode() === 'ring') {
      this.updateChart_Ring();
    } else {
      this.updateChart_Legacy();
    }
  }

  public getGraphs(): GraphInstance[] {
    return this.graphs;
  }

  private getContrastColor(hexColor: string): string {
    const hex = hexColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return yiq >= 180 ? '#000000' : '#ffffff';
  }

  private mapApiToD3_Ring(tx: Transaction): any {
    const txBlockHeight = tx.block_height || 0;

    const inputs = (tx.inputs || []).map((input, i) => {
      const ringMembers = (input.ring_members || []).map((rm, r) => {
        const rmHeight = rm.block_height || 0;
        const ageDelta = Math.max(0, txBlockHeight - rmHeight);
        const count = rm.decoy_count || 0;

        if (count > this.globalMaxDecoyCount) {
          this.globalMaxDecoyCount = count;
        }

        return {
          id: `rm-${tx.tx_hash}-${i}-${r}`,
          type: 'ring_member',
          hash: rm.hash,
          parent_tx_id: rm.parent_transaction,
          output_stealth_address: rm.hash,
          block_height: rmHeight,
          age_delta: ageDelta,
          decoy_count: count,
          is_coinbase: rm.is_coinbase,
        };
      });

      ringMembers.sort((a, b) => a.age_delta - b.age_delta);

      return {
        id: `in-${tx.tx_hash}-${i}`,
        type: ringMembers.length === 0 ? 'coinbase_start' : 'input',
        ring_members: ringMembers,
        key_image: input.key_image,
      };
    });

    const outputs = (tx.outputs || []).map((out, i) => ({
      id: `out-${tx.tx_hash}-${i}`,
      type: 'output',
      output_index: out.output_index,
      stealth_address: out.stealth_address,
    }));

    return {
      id: tx.tx_hash,
      type: 'tx',
      inputs: inputs,
      outputs: outputs,
      block_height: txBlockHeight,
      raw: tx,
    };
  }

  private updateGraphLayout_Ring(graph: GraphInstance): void {
    const inputSpacing = 200;
    const outputSpacing = 35;
    const layoutWidth = 560;

    const inputLayout = d3.tree().nodeSize([inputSpacing, layoutWidth / 2]);
    const outputLayout = d3.tree().nodeSize([outputSpacing, layoutWidth / 2]);

    inputLayout(graph.inputRoot);
    outputLayout(graph.outputRoot);

    const normalize = (node: any, isInput: boolean) => {
      node.y = isInput ? -node.y : node.y;

      if (node.data.type === 'coinbase_start') {
        node.y += 180;
      }
      if (node.data.type === 'ring_member') {
        node.y += node.data.calculated_shift || 0;
      }
      if (node.depth === 0) {
        node.x = 0;
        node.y = 0;
      }
    };

    graph.inputRoot.descendants().forEach((d) => normalize(d, true));
    graph.outputRoot.descendants().forEach((d) => normalize(d, false));
  }

  private addTransactionToGraph_Ring(
    txData: any,
    alignTarget: any = null,
    expandAll: boolean = false,
    rotationEnabled: boolean = false,
  ): void {
    const inputRoot = d3.hierarchy(txData, (d) => d.inputs);
    const outputRoot = d3.hierarchy(txData, (d) => d.outputs);

    const graph: GraphInstance = {
      id: txData.id,
      inputRoot,
      outputRoot,
      offsetX: 0,
      offsetY: 0,
      connector: null,
      expandedNodeIds: new Set(),
      rotationEnabled: rotationEnabled,
    };

    this.isEmpty.set(false);
    this.updateGraphLayout_Ring(graph);

    if (alignTarget) {
      const targetStealthAddress = alignTarget.data.hash;
      const matchNode: any = outputRoot
        .leaves()
        .find((d: any) => d.data.stealth_address === targetStealthAddress);

      const anchorX = alignTarget.absoluteX;
      const anchorY = alignTarget.absoluteY;
      const spacing = 300;
      const proposedOffsetX = alignTarget.centerX - spacing - (matchNode ? matchNode.y : 0);
      const proposedOffsetY = anchorY - (matchNode ? matchNode.x : 0);

      let newMinY = Infinity;
      let newMaxY = -Infinity;
      const measure = (n: any) => {
        let r = 10;
        if (n.data.type === 'input') r = 90;
        if (n.data.type === 'tx' || n.data.type === 'coinbase_start') r = 15;
        if (n.x - r < newMinY) newMinY = n.x - r;
        if (n.x + r > newMaxY) newMaxY = n.x + r;
      };
      graph.inputRoot.descendants().forEach(measure);
      graph.outputRoot.descendants().forEach(measure);

      const columnBuffer = 200;
      const colliders = this.graphs.filter(
        (g) => Math.abs(g.offsetX - proposedOffsetX) < columnBuffer,
      );

      const blockedIntervals: { min: number; max: number }[] = [];
      colliders.forEach((g) => {
        let gMinY = Infinity;
        let gMaxY = -Infinity;
        const measureG = (n: any) => {
          let r = 10;
          if (n.data.type === 'input') r = 90;
          if (n.data.type === 'tx' || n.data.type === 'coinbase_start') r = 15;
          const absY = n.x + g.offsetY;
          if (absY - r < gMinY) gMinY = absY - r;
          if (absY + r > gMaxY) gMaxY = absY + r;
        };
        g.inputRoot.descendants().forEach(measureG);
        g.outputRoot.descendants().forEach(measureG);
        blockedIntervals.push({ min: gMinY, max: gMaxY });
      });

      const candidates = [proposedOffsetY];
      const gapPadding = 50;
      blockedIntervals.forEach((block) => {
        candidates.push(block.min - gapPadding - newMaxY);
        candidates.push(block.max + gapPadding - newMinY);
      });
      candidates.sort((a, b) => Math.abs(a - proposedOffsetY) - Math.abs(b - proposedOffsetY));

      let finalOffsetY = proposedOffsetY;
      for (const y of candidates) {
        const myTop = y + newMinY;
        const myBottom = y + newMaxY;
        let overlap = false;
        for (const block of blockedIntervals) {
          if (myTop < block.max && myBottom > block.min) {
            overlap = true;
            break;
          }
        }
        if (!overlap) {
          finalOffsetY = y;
          break;
        }
      }

      graph.offsetX = proposedOffsetX;
      graph.offsetY = finalOffsetY;

      graph.connector = {
        originGraphId: alignTarget.originGraphId,
        originNodeId: alignTarget.data.id,
        targetNode: matchNode || { y: 300, x: 0 },
        originX: anchorX,
        originY: anchorY,
        originAngle: alignTarget.angle,
      };
    }

    this.graphs.push(graph);
    this.updateChart_Ring();
  }

  private updateChart_Ring(): void {
    if (!this.treeContainer) return;
    const element = this.treeContainer.nativeElement;
    const { width, height } = element.getBoundingClientRect();

    if (this.graphs.length > 0) {
      this.resolveCollisions_Ring();
    }

    let minY = Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;

    if (this.graphs.length > 0) {
      this.graphs.forEach((g) => {
        const updateBounds = (node: any) => {
          const absY = node.x + g.offsetY;
          if (absY < minY) minY = absY;
          if (absY > maxY) maxY = absY;
          const absX = node.y + g.offsetX;
          if (absX < minX) minX = absX;
          if (absX > maxX) maxX = absX;
        };
        g.inputRoot.descendants().forEach(updateBounds);
        g.outputRoot.descendants().forEach(updateBounds);
      });
    } else {
      minY = -300;
      maxY = 300;
      minX = -300;
      maxX = 300;
    }

    const padding = 200;
    const contentHeight = maxY - minY + padding;

    if (this.initialContainerHeight === null) {
      const maxContainerHeight = window.innerHeight - 400;
      this.initialContainerHeight = Math.max(Math.min(contentHeight, maxContainerHeight), 300);
    }

    const drawHeight =
      this.isFullscreen() || this.fillParent ? window.innerHeight : this.initialContainerHeight;
    const drawWidth = this.isFullscreen() || this.fillParent ? window.innerWidth : width;

    if (!this.svgSelection) {
      this.svgSelection = d3.select(element).append('svg');
      this.containerSelection = this.svgSelection.append('g');

      this.zoomBehavior = d3
        .zoom()
        .scaleExtent([0.1, 2])
        .on('zoom', (e) => {
          this.containerSelection.attr('transform', e.transform);
        });

      this.svgSelection.call(this.zoomBehavior).on('dblclick.zoom', null);

      const contentCenterY = (minY + maxY) / 2;
      const initialTranslateY = drawHeight / 2 - contentCenterY;
      const contentCenterX = (minX + maxX) / 2;
      const initialTranslateX = drawWidth / 2 - contentCenterX;

      if (this.preservedZoom) {
        this.svgSelection.call(this.zoomBehavior.transform, this.preservedZoom);
        this.preservedZoom = null;
      } else {
        this.svgSelection.call(
          this.zoomBehavior.transform,
          d3.zoomIdentity.translate(initialTranslateX, initialTranslateY),
        );
      }
    }

    this.svgSelection.attr('width', drawWidth).attr('height', drawHeight);
    element.style.height = `${drawHeight}px`;

    this.containerSelection.selectAll('*').remove();

    const nodesLayerBottom = this.containerSelection
      .append('g')
      .attr('class', 'nodes-layer-bottom');
    const linksLayer = this.containerSelection.append('g').attr('class', 'links-layer');
    const bridgesLayer = this.containerSelection.append('g').attr('class', 'bridges-layer');
    const nodesLayerTop = this.containerSelection.append('g').attr('class', 'nodes-layer-top');

    const bridgeOutputs = new Set<string>();

    this.graphs.forEach((graph) => {
      graph.inputRoot.leaves().forEach((node: any) => {
        if (node.data.type === 'input') {
          const members = node.data.ring_members;
          const minAge = d3.min(members, (d: any) => d.age_delta as number) as unknown as number;
          const maxAge = d3.max(members, (d: any) => d.age_delta as number) as unknown as number;
          const maxCount = d3.max(
            members,
            (d: any) => d.decoy_count as number,
          ) as unknown as number;

          this.radiusScale.domain([minAge || 0, maxAge || 0]);
          this.thicknessScale.domain([0, maxCount || 1]);

          members.forEach((m: any) => {
            m.plotRadius = this.radiusScale(m.age_delta);
            m.plotThickness = this.thicknessScale(m.decoy_count);
          });
          const arcs = this.pieGenerator(members);

          if (graph.rotationEnabled) {
            let firstExpandedInRing = null;
            for (const id of graph.expandedNodeIds) {
              if (members.some((m: any) => m.id === id)) {
                firstExpandedInRing = id;
                break;
              }
            }

            if (firstExpandedInRing) {
              const anchorArc = arcs.find((a: any) => a.data.id === firstExpandedInRing);
              if (anchorArc) {
                const currentMid = (anchorArc.startAngle + anchorArc.endAngle) / 2;
                const target = -Math.PI / 2;
                const rotation = target - currentMid;
                arcs.forEach((a: any) => {
                  a.startAngle += rotation;
                  a.endAngle += rotation;
                });
              }
            }
          }
          node.data.arcs = arcs;
        }
      });
    });

    this.graphs.forEach((graph) => {
      if (graph.connector) {
        bridgeOutputs.add(graph.connector.targetNode.data.id);
        const targetNode = graph.connector.targetNode;
        const endX = targetNode.y + graph.offsetX;
        const endY = targetNode.x + graph.offsetY;
        let startX: number | undefined, startY: number | undefined;
        let pathData = '';
        const parentGraph = this.graphs.find((g) => g.id === graph.connector!.originGraphId);

        if (parentGraph) {
          const inputNode = parentGraph.inputRoot
            .leaves()
            .find((n: any) =>
              n.data.ring_members?.some((rm: any) => rm.id === graph.connector!.originNodeId),
            );
          if (inputNode && inputNode.data.arcs) {
            const arc = inputNode.data.arcs.find(
              (a: any) => a.data.id === graph.connector!.originNodeId,
            );
            if (arc) {
              const centerX = inputNode.y! + parentGraph.offsetX;
              const centerY = inputNode.x! + parentGraph.offsetY;
              const r = MAX_RADIUS + MAX_THICKNESS + OUTER_EDGE_BUFFER;
              const startPoint = this.getOuterEdgePoint(
                centerX,
                centerY,
                arc.startAngle,
                arc.endAngle,
                r,
              );
              startX = startPoint.x;
              startY = startPoint.y;
              const angle = (arc.startAngle + arc.endAngle) / 2;
              const cp1dist = 80;
              const cp1x = startX + cp1dist * Math.sin(angle);
              const cp1y = startY - cp1dist * Math.cos(angle);
              const cp2x = endX + 50;
              const cp2y = endY;
              pathData = `M ${startX},${startY} C ${cp1x},${cp1y} ${cp2x},${cp2y} ${endX},${endY}`;
            }
          }
        }
        if (!pathData) {
          if (startX === undefined) {
            startX = parentGraph?.offsetX || 0;
            startY = parentGraph?.offsetY || 0;
          }
          const cp1x = (startX + endX) / 2;
          pathData = `M ${startX},${startY} C ${cp1x},${startY} ${cp1x},${endY} ${endX},${endY}`;
        }

        this.drawBridgeLink_Ring(bridgesLayer, pathData, graph.connector!.originNodeId);
      }

      if (graph.extraConnectors) {
        graph.extraConnectors.forEach((extra) => {
          bridgeOutputs.add(extra.targetNode.data.id);
          const inputNode = graph.inputRoot
            .leaves()
            .find((n: any) =>
              n.data.ring_members?.some((rm: any) => rm.id === extra.originNodeData.id),
            );
          if (inputNode && inputNode.data.arcs) {
            const arc = inputNode.data.arcs.find((a: any) => a.data.id === extra.originNodeData.id);
            if (arc) {
              const centerX = inputNode.y! + graph.offsetX;
              const centerY = inputNode.x! + graph.offsetY;
              const r = MAX_RADIUS + MAX_THICKNESS + OUTER_EDGE_BUFFER;
              const origin = this.getOuterEdgePoint(
                centerX,
                centerY,
                arc.startAngle,
                arc.endAngle,
                r,
              );
              const endX = extra.targetNode.y + extra.targetGraph.offsetX;
              const endY = extra.targetNode.x + extra.targetGraph.offsetY;
              const angle = (arc.startAngle + arc.endAngle) / 2;
              const cp1dist = 80;
              const cp1x = origin.x + cp1dist * Math.sin(angle);
              const cp1y = origin.y - cp1dist * Math.cos(angle);
              const cp2x = endX + 50;
              const cp2y = endY;
              const pathData = `M ${origin.x},${origin.y} C ${cp1x},${cp1y} ${cp2x},${cp2y} ${endX},${endY}`;
              this.drawBridgeLink_Ring(bridgesLayer, pathData, extra.originNodeData.id);
            }
          }
        });
      }
    });

    this.graphs.forEach((graph) => {
      const parentCounts = new Map<string, number>();
      graph.inputRoot.leaves().forEach((inputNode: any) => {
        if (inputNode.data.ring_members) {
          inputNode.data.ring_members.forEach((rm: any) => {
            const pid = rm.parent_tx_id;
            if (pid) parentCounts.set(pid, (parentCounts.get(pid) || 0) + 1);
          });
        }
      });

      const drawNodeContent = (d: any, i: any, nodes: any) => {
        const el = d3.select(nodes[i]);
        const type = d.data.type;

        if (type === 'tx') {
          el.append('rect')
            .attr('x', -50)
            .attr('y', -10)
            .attr('width', 100)
            .attr('height', 20)
            .attr('fill', 'var(--graphNodeFill)')
            .attr('stroke', 'var(--graphNodeStroke)')
            .attr('rx', 5);
          el.append('text')
            .attr('dy', 4)
            .attr('text-anchor', 'middle')
            .text(`Tx: ${d.data.id.substring(0, 4)}...${d.data.id.slice(-4)}`)
            .style('fill', 'var(--graphText)')
            .style('font-size', '10px');

          const label = this.txLabels.get(d.data.id);
          if (label) {
            const labelGroup = el.append('g').attr('transform', 'translate(0, -27)');

            const maxLabelWidth = 350;
            let displayText = label.text;
            let estimatedWidth = Math.max(label.text.length * 6 + 10, 40);

            if (estimatedWidth > maxLabelWidth) {
              estimatedWidth = maxLabelWidth;
              const maxChars = Math.floor((maxLabelWidth - 20) / 6);
              displayText = label.text.substring(0, maxChars) + '...';
            }

            labelGroup
              .append('rect')
              .attr('class', 'label-rect')
              .attr('x', -estimatedWidth / 2)
              .attr('y', -10)
              .attr('width', estimatedWidth)
              .attr('height', 20)
              .style('fill', label.color)
              .attr('rx', 5);
            labelGroup
              .append('text')
              .attr('dy', 4)
              .attr('text-anchor', 'middle')
              .text(displayText)
              .style('fill', this.getContrastColor(label.color))
              .style('font-size', '11px')
              .style('font-weight', '500')
              .style('letter-spacing', '-0.25px')
              .style('font-family', 'Google Sans Code');

            labelGroup.on('mouseover', (e: MouseEvent) => e.stopPropagation());
          }

          el.style('cursor', 'pointer');
          el.on('contextmenu', (e: MouseEvent) => this.handleNodeContextMenu(e, d));
          el.on('click', (e: MouseEvent) => this.handleNodeClick_Ring(e, d, graph));
          el.on('mouseover', (e: MouseEvent) => {
            this.showTooltip(
              e,
              `<strong>TX</strong><br>Height: ${d.data.block_height || 'N/A'}<br>Hash: ${d.data.id.substring(0, 8)}...${d.data.id.slice(-8)}`,
            );
          }).on('mouseout', () => this.hideTooltip());
        } else if (type === 'coinbase_start') {
          el.append('rect')
            .attr('x', -40)
            .attr('y', -10)
            .attr('width', 80)
            .attr('height', 20)
            .style('fill', 'var(--graphCoinbaseFill)')
            .style('stroke', 'var(--graphCoinbaseStroke)')
            .attr('rx', 5);
          el.append('text')
            .attr('dy', 4)
            .attr('text-anchor', 'middle')
            .text('Coinbase')
            .style('fill', 'var(--coinbaseColor)')
            .style('font-size', '10px');
        } else if (type === 'output') {
          const isHighlighted = d.data.stealth_address === this.highlightedAddress;
          let fillColor = 'steelblue';
          if (bridgeOutputs.has(d.data.id)) fillColor = 'var(--graphEdgeBridge)';
          if (isHighlighted) fillColor = '#DF560A';

          el.append('path').attr('d', 'M -5,-5 L 5,0 L -5,5 Z').attr('fill', fillColor);
          el.on('click', (e: MouseEvent) => this.handleNodeClick_Ring(e, d, graph));
          el.on('mouseover', (e: MouseEvent) => {
            this.showTooltip(
              e,
              `<strong>OUTPUT</strong><br>Stealth Address:<br>${d.data.stealth_address.substring(0, 6)}...${d.data.stealth_address.slice(-6)}`,
            );
          }).on('mouseout', () => this.hideTooltip());
        } else if (type === 'input') {
          if (d.data.arcs) {
            const handleRingClick = (e: MouseEvent, arc: any) => {
              e.stopPropagation();
              const centerX = d.y + graph.offsetX;
              const centerY = d.x + graph.offsetY;
              const r = MAX_RADIUS + MAX_THICKNESS + OUTER_EDGE_BUFFER;
              const anchor = this.getOuterEdgePoint(
                centerX,
                centerY,
                arc.startAngle,
                arc.endAngle,
                r,
              );
              this.handleRingMemberClick_Ring(arc, anchor, graph, centerX, centerY);
            };

            const handleTooltipOver = (e: MouseEvent, arc: any) => {
              d3.select(e.currentTarget as any)
                .attr('stroke', 'var(--graphNodeFill)')
                .attr('stroke-width', 2);
              const html = `<strong>RING MEMBER</strong><br>Hash: ${arc.data.hash.substring(0, 6)}...${arc.data.hash.slice(-6)}<br>Age: ${arc.data.age_delta} blocks<br>Usage Count: ${arc.data.decoy_count}`;
              this.showTooltip(e, html);
            };

            el.append('g')
              .attr('class', 'ring-background')
              .selectAll('path')
              .data(d.data.arcs)
              .enter()
              .append('path')
              .attr('d', this.bgArcGenerator)
              .attr('fill', (arc: any) =>
                graph.expandedNodeIds.has(arc.data.id)
                  ? 'var(--graphRingBgExpanded)'
                  : 'var(--graphRingBg)',
              )
              .attr('stroke', 'none')
              .style('cursor', 'pointer')
              .on('click', handleRingClick)
              .on('mouseover', handleTooltipOver)
              .on('mouseout', (e: MouseEvent) => {
                d3.select(e.currentTarget as any).attr('stroke', 'none');
                this.hideTooltip();
              });

            el.append('g')
              .attr('class', 'ring-segments')
              .selectAll('path')
              .data(d.data.arcs)
              .enter()
              .append('path')
              .attr('d', this.mainArcGenerator)
              .attr('fill', (arc: any) => {
                const m = arc.data;
                const pid = m.parent_tx_id;
                const isDuplicate = pid && parentCounts.get(pid)! > 1;
                const isHighlighted = pid && this.clipboardService.allHighlightedHashes().has(pid);
                if (m.hash.startsWith('00000000')) return 'var(--graphSegmentDanger)';
                if (m.is_coinbase) return 'var(--graphSegmentCoinbase)';
                if (isDuplicate) return 'var(--graphSegmentDuplicate)';
                if (isHighlighted) return '#FF00FF';
                if (m.age_delta <= 0) return 'var(--graphSegmentAge0)';
                if (m.age_delta <= 10) return 'var(--graphSegmentAge1)';
                if (m.age_delta <= 1440) return 'var(--graphSegmentAge2)';
                if (m.age_delta <= 21600) return 'var(--graphSegmentAge3)';
                return 'var(--graphSegmentDefault)';
              })
              .attr('stroke', (arc: any) =>
                graph.expandedNodeIds.has(arc.data.id)
                  ? 'var(--graphSegmentExpanded)'
                  : 'var(--graphRingBg)',
              )
              .attr('stroke-width', 1)
              .style('cursor', 'pointer')
              .on('click', handleRingClick)
              .on('mouseover', handleTooltipOver)
              .on('mouseout', (e: MouseEvent, arc: any) => {
                const isExpanded = graph.expandedNodeIds.has(arc.data.id);
                d3.select(e.currentTarget as any)
                  .attr('stroke', isExpanded ? 'var(--graphSegmentExpanded)' : 'var(--graphRingBg)')
                  .attr('stroke-width', 1);
                this.hideTooltip();
              });
          }
        }
      };

      [graph.inputRoot, graph.outputRoot].forEach((root) => {
        const links = root.links();
        const allNodes = root.descendants();
        const bottomNodes = allNodes.filter(
          (d: any) =>
            d.data.type !== 'output' && d.data.type !== 'tx' && d.data.type !== 'coinbase_start',
        );
        const topNodes = allNodes.filter(
          (d: any) =>
            d.data.type === 'output' || d.data.type === 'tx' || d.data.type === 'coinbase_start',
        );

        linksLayer
          .selectAll(`path.link-${graph.id}-${root.data.type}`)
          .data(links)
          .enter()
          .append('path')
          .attr('class', (d: any) => {
            let c = 'link';
            if (
              d.source.data.type === 'tx' &&
              d.target.data.type === 'output' &&
              bridgeOutputs.has(d.target.data.id)
            )
              c += ' connected-path';
            return c;
          })
          .attr(
            'd',
            d3
              .linkHorizontal()
              .x((d: any) => {
                let x = d.y + graph.offsetX;
                if (d.data.type === 'input') x += MAX_RADIUS + MAX_THICKNESS + OUTER_EDGE_BUFFER;
                return x;
              })
              .y((d: any) => d.x + graph.offsetY),
          );

        nodesLayerBottom
          .selectAll(`g.node-bottom-${graph.id}-${root.data.type}`)
          .data(bottomNodes)
          .enter()
          .append('g')
          .attr('class', 'node node-input')
          .attr('transform', (d: any) => `translate(${d.y + graph.offsetX},${d.x + graph.offsetY})`)
          .each(drawNodeContent);

        nodesLayerTop
          .selectAll(`g.node-top-${graph.id}-${root.data.type}`)
          .data(topNodes)
          .enter()
          .append('g')
          .attr('class', (d: any) => `node node-${d.data.type.split('_')[0]}`)
          .attr('transform', (d: any) => `translate(${d.y + graph.offsetX},${d.x + graph.offsetY})`)
          .each(drawNodeContent);
      });
    });
  }

  private handleNodeClick_Ring(event: MouseEvent, d: any, graph: GraphInstance): void {
    this.hideTooltip();
    event.stopPropagation();
    const type = d.data.type;
    if (type === 'tx') {
      event.preventDefault();
      const currentLabelData = this.txLabels.get(d.data.id) || { text: '', color: '#e04f5f' };

      this.modalService.open('edit-label', {
        txId: d.data.id,
        currentText: currentLabelData.text,
        currentColor: currentLabelData.color,
        onSave: (text: string, color: string) => {
          if (!text || text.trim() === '') {
            this.txLabels.delete(d.data.id);
          } else {
            this.txLabels.set(d.data.id, { text: text.trim(), color: color });
          }
          this.updateChart();
        },
      });
      return;
    }
    if (type === 'output') {
      const txData = d.parent.data;
      const version = txData.raw?.version;
      const outputIndex = d.data.output_index;
      if (version <= 1 || outputIndex === 0) {
        window.alert('pre-RingCT transactions with version 1 or lower are not supported');
      } else {
        this.navigateToDecoyMap(txData.id, d.data.stealth_address, outputIndex);
      }
    }
  }

  private handleRingMemberClick_Ring(
    arc: any,
    anchor: { x: number; y: number },
    graph: GraphInstance,
    centerX: number,
    centerY: number,
  ): void {
    this.hideTooltip();
    const d = arc.data;
    if (this.isGraphLoading()) return;

    const alreadyExpanded = graph.expandedNodeIds.has(d.id);
    if (alreadyExpanded) {
      this.removeDownstreamGraphs_Ring([d.id]);
      this.updateChart_Ring();
      return;
    }

    const parentId = d.parent_tx_id;
    if (!parentId) return;

    const existingGraph = this.graphs.find((g) => g.id === parentId);
    if (existingGraph) {
      const targetStealthAddress = d.hash;
      const matchNode: any = existingGraph.outputRoot
        .leaves()
        .find((n: any) => n.data.stealth_address === targetStealthAddress);
      if (matchNode) {
        if (!graph.extraConnectors) graph.extraConnectors = [];
        graph.extraConnectors.push({
          originNodeData: d,
          targetNode: matchNode,
          targetGraph: existingGraph,
        });
        graph.expandedNodeIds.add(d.id);
        this.updateChart_Ring();
      }
      return;
    }

    const isFirstConnection = graph.expandedNodeIds.size === 0;
    let targetAngle = (arc.startAngle + arc.endAngle) / 2;
    let targetAnchor = anchor;

    if (graph.rotationEnabled && isFirstConnection) {
      targetAngle = -Math.PI / 2;
      const r = MAX_RADIUS + MAX_THICKNESS + OUTER_EDGE_BUFFER;
      targetAnchor = { x: centerX - r, y: centerY };
    }

    graph.expandedNodeIds.add(d.id);
    this.isGraphLoading.set(true);

    const alignTarget = {
      absoluteX: targetAnchor.x,
      absoluteY: targetAnchor.y,
      centerX: centerX,
      data: d,
      originGraphId: graph.id,
      angle: targetAngle,
    };

    this.transactionService.getTransaction(parentId).subscribe({
      next: (parentTxApi) => {
        const parentTx = this.mapApiToD3_Ring(parentTxApi);
        if (parentTx) {
          this.addTransactionToGraph_Ring(parentTx, alignTarget, false, false);
        } else {
          graph.expandedNodeIds.delete(d.id);
          this.updateChart_Ring();
        }
        this.isGraphLoading.set(false);
      },
      error: (err) => {
        console.error(err);
        graph.expandedNodeIds.delete(d.id);
        this.updateChart_Ring();
        this.isGraphLoading.set(false);
      },
    });
  }

  private removeDownstreamGraphs_Ring(ringMemberIds: string[]): void {
    this.graphs.forEach((g) => {
      if (g.extraConnectors) {
        g.extraConnectors = g.extraConnectors.filter(
          (ec) => !ringMemberIds.includes(ec.originNodeData.id),
        );
      }
    });

    const graphsToRemove = this.graphs.filter(
      (g) => g.connector && ringMemberIds.includes(g.connector.originNodeId),
    );
    if (graphsToRemove.length === 0) return;

    graphsToRemove.forEach((g) => {
      const allInputNodes = g.inputRoot.leaves();
      const allRingMemberIds: string[] = [];
      allInputNodes.forEach((inode: any) => {
        if (inode.data.ring_members) {
          inode.data.ring_members.forEach((rm: any) => allRingMemberIds.push(rm.id));
        }
      });
      this.removeDownstreamGraphs_Ring(allRingMemberIds);
      const parentGraph = this.graphs.find((pg) => {
        const inputs = pg.inputRoot.leaves();
        return inputs.some((inode: any) =>
          inode.data.ring_members?.some((rm: any) => rm.id === g.connector!.originNodeId),
        );
      });
      if (parentGraph && g.connector) {
        parentGraph.expandedNodeIds.delete(g.connector.originNodeId);
      }
    });
    const idsToRemove = new Set(graphsToRemove.map((g) => g.id));
    this.graphs = this.graphs.filter((g) => !idsToRemove.has(g.id));
  }

  private drawBridgeLink_Ring(container: any, pathData: string, originId: string) {
    const group = container.append('g').attr('class', 'bridge-group').attr('data-id', originId);
    group
      .append('path')
      .attr('class', 'link-halo')
      .attr('d', pathData)
      .style('stroke', 'var(--background)')
      .style('stroke-width', '5px')
      .style('fill', 'none')
      .style('opacity', '1');
    group
      .append('path')
      .attr('class', 'link bridge connected-path')
      .attr('d', pathData)
      .style('stroke', 'var(--graphEdgeBridge)')
      .style('stroke-width', '2px')
      .style('fill', 'none')
      .style('opacity', '0.6');
  }

  private resolveCollisions_Ring(): void {
    const iterations = 10;
    const padding = 60;
    const getBounds = (g: GraphInstance) => {
      let minY = Infinity,
        maxY = -Infinity,
        minX = Infinity,
        maxX = -Infinity;
      const update = (node: any) => {
        const absY = node.x + g.offsetY;
        const absX = node.y + g.offsetX;
        let rY = 0,
          rX = 0;
        if (node.data.type === 'input') {
          rY = 90;
          rX = 90;
        } else if (node.data.type === 'tx' || node.data.type === 'coinbase_start') {
          rY = 15;
          rX = 50;
        } else {
          rY = 10;
          rX = 10;
        }
        if (absY - rY < minY) minY = absY - rY;
        if (absY + rY > maxY) maxY = absY + rY;
        if (absX - rX < minX) minX = absX - rX;
        if (absX + rX > maxX) maxX = absX + rX;
      };
      g.inputRoot.descendants().forEach(update);
      g.outputRoot.descendants().forEach(update);
      return { minX, maxX, minY, maxY, id: g.id };
    };

    for (let k = 0; k < iterations; k++) {
      let hasCollision = false;
      const bounds = this.graphs.map((g) => ({ g, rect: getBounds(g) }));
      for (let i = 0; i < bounds.length; i++) {
        for (let j = i + 1; j < bounds.length; j++) {
          const b1 = bounds[i];
          const b2 = bounds[j];
          const xBuffer = 20;
          const noXOverlap =
            b1.rect.maxX < b2.rect.minX - xBuffer || b1.rect.minX > b2.rect.maxX + xBuffer;
          if (noXOverlap) continue;
          const noYOverlap =
            b1.rect.maxY < b2.rect.minY - padding || b1.rect.minY > b2.rect.maxY + padding;
          if (!noYOverlap) {
            hasCollision = true;
            const overlapHeight =
              Math.min(b1.rect.maxY, b2.rect.maxY) - Math.max(b1.rect.minY, b2.rect.minY) + padding;
            const c1 = (b1.rect.minY + b1.rect.maxY) / 2;
            const c2 = (b2.rect.minY + b2.rect.maxY) / 2;
            const shift = overlapHeight / 2;
            if (c1 < c2) {
              b1.g.offsetY -= shift;
              b2.g.offsetY += shift;
            } else {
              b2.g.offsetY -= shift;
              b1.g.offsetY += shift;
            }
          }
        }
      }
      if (!hasCollision) break;
    }
  }

  private mapApiToD3_Legacy(tx: Transaction): any {
    const txBlockHeight = tx.block_height || 0;
    const inputs = (tx.inputs || []).map((input, i) => {
      const ringMembers = (input.ring_members || []).map((rm, r) => {
        const rmHeight = rm.block_height || 0;
        const ageDelta = Math.max(0, txBlockHeight - rmHeight);
        const count = rm.decoy_count || 0;
        if (count > this.globalMaxDecoyCount) this.globalMaxDecoyCount = count;
        return {
          id: `rm-${tx.tx_hash}-${i}-${r}`,
          type: 'ring_member',
          hash: rm.hash,
          parent_tx_id: rm.parent_transaction,
          output_stealth_address: rm.hash,
          block_height: rmHeight,
          age_delta: ageDelta,
          decoy_count: count,
          is_coinbase: rm.is_coinbase,
        };
      });
      return {
        id: `in-${tx.tx_hash}-${i}`,
        type: 'input',
        children: ringMembers,
        key_image: input.key_image,
      };
    });

    const outputs = (tx.outputs || []).map((out, i) => ({
      id: `out-${tx.tx_hash}-${i}`,
      type: 'output',
      output_index: out.output_index,
      stealth_address: out.stealth_address,
    }));

    return {
      id: tx.tx_hash,
      type: 'tx',
      inputs: inputs,
      outputs: outputs,
      block_height: txBlockHeight,
      raw: tx,
    };
  }

  private updateGraphLayout_Legacy(graph: GraphInstance): void {
    const layoutWidth = 600;

    const treeLayout = d3.tree().nodeSize([10, 240]);
    treeLayout(graph.inputRoot);
    treeLayout(graph.outputRoot);

    const VERTICAL_GAP = 10;
    const LEGACY_MIN_RADIUS = 2;
    const LEGACY_MAX_RADIUS = 12;

    const getNodeRadius = (node: any) => {
      if (node.data.type === 'ring_member') {
        const count = node.data.decoy_count || 0;
        const ratio = count / this.globalMaxDecoyCount;
        return LEGACY_MIN_RADIUS + ratio * (LEGACY_MAX_RADIUS - LEGACY_MIN_RADIUS);
      } else if (node.data.type === 'output') {
        return 5;
      } else if (node.data.type === 'input') {
        return 6;
      } else if (node.data.type === 'tx') {
        return 10;
      }
      return 5;
    };

    let currentY = 0;

    if (graph.inputRoot.children) {
      graph.inputRoot.children.forEach((inputNode: any) => {
        const children = inputNode.children || [];

        if (children.length > 0) {
          let localY = 0;
          if (children.length > 0) {
            localY = getNodeRadius(children[0]);
            children[0].x = currentY + localY;

            for (let i = 1; i < children.length; i++) {
              const prev = children[i - 1];
              const curr = children[i];
              const rPrev = getNodeRadius(prev);
              const rCurr = getNodeRadius(curr);
              const gap = rPrev + VERTICAL_GAP + rCurr;
              localY += gap;
              curr.x = currentY + localY;
            }
          }

          const firstChild = children[0];
          const lastChild = children[children.length - 1];
          const blockHeight = lastChild.x - firstChild.x;
          inputNode.x = firstChild.x + blockHeight / 2;

          const lastChildRadius = getNodeRadius(lastChild);
          currentY = lastChild.x + lastChildRadius + 10;
        } else {
          const r = getNodeRadius(inputNode);
          currentY += r;
          inputNode.x = currentY;
          currentY += r + 10;
        }

        if (children.length > 0) {
          const maxAgeInRingValue = d3.max(children, (c: any) => +c.data.age_delta);
          const maxAgeInRing = maxAgeInRingValue === undefined ? 1 : maxAgeInRingValue;
          children.forEach((child: any) => {
            if (child.data) {
              const ratio = child.data.age_delta / maxAgeInRing;
              child.data.calculated_shift = -(ratio * (RING_WIDTH_PIXELS * 0.5));
            }
          });
        }
      });
    }

    let inputsCenterY = currentY / 2;
    if (graph.inputRoot.children && graph.inputRoot.children.length > 0) {
      const first = graph.inputRoot.children[0];
      const last = graph.inputRoot.children[graph.inputRoot.children.length - 1];
      inputsCenterY = ((first.x || 0) + (last.x || 0)) / 2;
    }

    let outputStartY = 0;
    if (graph.outputRoot.children) {
      const outputs = graph.outputRoot.children;
      outputs.forEach((outNode: any, i: number) => {
        const r = getNodeRadius(outNode);
        if (i === 0) {
          outputStartY += r;
          outNode.x = outputStartY;
        } else {
          const prev = outputs[i - 1];
          const rPrev = getNodeRadius(prev);
          const OUTPUT_GAP = 25;
          outputStartY += rPrev + OUTPUT_GAP + r;
          outNode.x = outputStartY;
        }
      });
    }
    let outputsCenterY = outputStartY / 2;
    if (graph.outputRoot.children && graph.outputRoot.children.length > 0) {
      const first = graph.outputRoot.children[0];
      const last = graph.outputRoot.children[graph.outputRoot.children.length - 1];
      outputsCenterY = ((first.x || 0) + (last.x || 0)) / 2;
    }

    const shiftInputs = -inputsCenterY;
    const shiftOutputs = -outputsCenterY;

    const applyShift = (node: any, shift: number) => {
      node.x += shift;
      if (node.children) node.children.forEach((c: any) => applyShift(c, shift));
      if (node._children) node._children.forEach((c: any) => applyShift(c, shift));
    };

    if (graph.inputRoot.children) {
      graph.inputRoot.children.forEach((c: any) => applyShift(c, shiftInputs));
    }
    graph.inputRoot.x = 0;

    if (graph.outputRoot.children) {
      graph.outputRoot.children.forEach((c: any) => applyShift(c, shiftOutputs));
    }
    graph.outputRoot.x = 0;

    const normalize = (node: any, isInput: boolean) => {
      if (isInput) {
        if (node.depth === 1) {
          node.y = -node.y * 0.6;
        } else if (node.depth === 2) {
          node.y = -(node.y / 2) * 0.6 - (node.y / 2) * 0.5;
        } else {
          node.y = -node.y;
        }
      } else {
        node.y = node.y === 0 ? 0 : node.y + 40;
      }

      if (node.data.type === 'ring_member') {
        node.y += node.data.calculated_shift || 0;
      }

      if (node.depth === 0) {
        node.x = 0;
        node.y = 0;
      }
    };

    graph.inputRoot.descendants().forEach((d) => normalize(d, true));
    graph.outputRoot.descendants().forEach((d) => normalize(d, false));
  }

  private addTransactionToGraph_Legacy(
    txData: any,
    alignTarget: any = null,
    expandAll: boolean = false,
  ): void {
    const inputRoot = d3.hierarchy(txData, (d) => d.inputs || d.children);
    const outputRoot = d3.hierarchy(txData, (d) => d.outputs);

    inputRoot.children?.forEach((inputNode: any, index: number) => {
      if (inputNode.children) {
        inputNode._allChildren = inputNode.children;
      }
    });

    const graph: GraphInstance = {
      id: txData.id,
      inputRoot,
      outputRoot,
      offsetX: 0,
      offsetY: 0,
      connector: null,
      expandedNodeIds: new Set(),
    };

    this.updateGraphLayout_Legacy(graph);
    this.isEmpty.set(false);

    if (alignTarget) {
      const targetStealthAddress = alignTarget.data.output_stealth_address;
      const matchNode: any = outputRoot
        .leaves()
        .find((d: any) => d.data.stealth_address === targetStealthAddress);
      const siblings = alignTarget.parent.children;
      const parentOffsetX = alignTarget.parentOffsetX;
      const minSiblingXValue = d3.min(siblings, (s: any) => s.y + parentOffsetX);
      const minSiblingX = minSiblingXValue === undefined ? 0 : +minSiblingXValue;
      const safeLimitX = minSiblingX - 100;
      const idealX = alignTarget.absoluteX;
      const finalConnectX = Math.min(idealX, safeLimitX);
      const idealOffsetY = alignTarget.graphCenterY;
      let proposedOffsetX = safeLimitX - 300;
      if (matchNode && typeof matchNode.y === 'number') {
        proposedOffsetX = finalConnectX - matchNode.y;
      }

      const getBounds = (g: GraphInstance, offX: number, offY: number) => {
        let minY = Infinity,
          maxY = -Infinity,
          minX = Infinity,
          maxX = -Infinity;
        const update = (node: any) => {
          const y = node.x + offY;
          const x = node.y + offX;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        };
        g.inputRoot.descendants().forEach(update);
        g.outputRoot.descendants().forEach(update);
        return { minX, maxX, minY, maxY };
      };

      const isOverlapping = (r1: any, r2: any) => {
        const xBuffer = 20;
        if (r2.minX > r1.maxX + xBuffer || r2.maxX < r1.minX - xBuffer) return false;
        return !(r2.minY > r1.maxY || r2.maxY < r1.minY);
      };

      let finalOffsetY = idealOffsetY;
      let collision = true;
      let step = 50;
      let maxSearch = 100;
      let currentIteration = 0;
      const tempGraph = { ...graph };

      while (currentIteration < maxSearch) {
        const offsetsToCheck =
          currentIteration === 0 ? [0] : [currentIteration * step, -currentIteration * step];
        for (const delta of offsetsToCheck) {
          const testY = idealOffsetY + delta;
          const newRect = getBounds(tempGraph, proposedOffsetX, testY);
          let hasCollision = false;
          for (const existingGraph of this.graphs) {
            const existingRect = getBounds(
              existingGraph,
              existingGraph.offsetX,
              existingGraph.offsetY,
            );
            if (isOverlapping(newRect, existingRect)) {
              hasCollision = true;
              break;
            }
          }
          if (!hasCollision) {
            finalOffsetY = testY;
            collision = false;
            break;
          }
        }
        if (!collision) break;
        currentIteration++;
      }
      if (collision) finalOffsetY = idealOffsetY + maxSearch * step;

      graph.offsetX = proposedOffsetX;
      graph.offsetY = finalOffsetY;

      if (matchNode && typeof matchNode.y === 'number') {
        graph.connector = {
          originGraphId: alignTarget.originGraphId,
          originNodeId: alignTarget.data.id,
          targetNode: matchNode,
        };
      } else {
        graph.connector = {
          originGraphId: alignTarget.originGraphId,
          originNodeId: alignTarget.data.id,
          targetNode: { y: 300, x: 0 },
        };
      }
    }

    this.graphs.push(graph);
    this.updateChart_Legacy();
  }

  private updateChart_Legacy(): void {
    if (!this.treeContainer) return;
    const element = this.treeContainer.nativeElement;
    const { width, height } = element.getBoundingClientRect();
    if (this.graphs.length > 0) this.resolveCollisions_Legacy();

    let minY = Infinity,
      maxY = -Infinity,
      minX = Infinity,
      maxX = -Infinity;
    if (this.graphs.length > 0) {
      this.graphs.forEach((g) => {
        const updateBounds = (node: any) => {
          const absY = node.x + g.offsetY;
          if (absY < minY) minY = absY;
          if (absY > maxY) maxY = absY;
          const absX = node.y + g.offsetX;
          if (absX < minX) minX = absX;
          if (absX > maxX) maxX = absX;
        };
        g.inputRoot.descendants().forEach(updateBounds);
        g.outputRoot.descendants().forEach(updateBounds);
      });
    } else {
      minY = -300;
      maxY = 300;
      minX = -300;
      maxX = 300;
    }

    const padding = 100;
    const contentHeight = maxY - minY + padding;

    if (this.initialContainerHeight === null) {
      const maxContainerHeight = window.innerHeight - 400;
      this.initialContainerHeight = Math.max(Math.min(contentHeight, maxContainerHeight), 300);
    }
    const drawHeight =
      this.isFullscreen() || this.fillParent ? window.innerHeight : this.initialContainerHeight;
    const drawWidth = this.isFullscreen() || this.fillParent ? window.innerWidth : width;

    if (!this.svgSelection) {
      this.svgSelection = d3.select(element).append('svg');
      this.containerSelection = this.svgSelection.append('g');
      this.zoomBehavior = d3
        .zoom()
        .scaleExtent([0.1, 2])
        .on('zoom', (e) => this.containerSelection.attr('transform', e.transform));
      this.svgSelection.call(this.zoomBehavior).on('dblclick.zoom', null);
      const txNodeAbsY = this.graphs.length > 0
        ? (this.graphs[0].inputRoot.x ?? 0) + this.graphs[0].offsetY
        : 0;
      const initialTranslateY = drawHeight / 2 - txNodeAbsY;
      const contentCenterX = (minX + maxX) / 2;
      const initialTranslateX = drawWidth / 2 - contentCenterX;
      if (this.preservedZoom) {
        this.svgSelection.call(this.zoomBehavior.transform, this.preservedZoom);
        this.preservedZoom = null;
      } else {
        this.svgSelection.call(
          this.zoomBehavior.transform,
          d3.zoomIdentity.translate(initialTranslateX, initialTranslateY),
        );
      }
    }
    this.svgSelection.attr('width', drawWidth).attr('height', drawHeight);
    element.style.height = `${drawHeight}px`;
    this.containerSelection.selectAll('*').remove();

    const tooltip = d3.select(this.tooltip.nativeElement);
    const bridgeOutputs = new Set<string>();

    this.graphs.forEach((g) => {
      if (g.connector && g.connector.targetNode) bridgeOutputs.add(g.connector.targetNode.data.id);
      if (g.extraConnectors)
        g.extraConnectors.forEach((extra) => bridgeOutputs.add(extra.targetNode.data.id));
    });

    this.graphs.forEach((graph) => {
      if (graph.connector) {
        const parentGraph = this.graphs.find((g) => g.id === graph.connector!.originGraphId);
        if (parentGraph) {
          let originNode = parentGraph.inputRoot
            .descendants()
            .find((d: any) => d.data.id === graph.connector!.originNodeId);
          if (!originNode)
            originNode = parentGraph.outputRoot
              .descendants()
              .find((d: any) => d.data.id === graph.connector!.originNodeId);

          if (originNode && graph.connector.targetNode) {
            const startX = originNode.y! + parentGraph.offsetX;
            const startY = originNode.x! + parentGraph.offsetY;
            const targetNode = graph.connector.targetNode;
            const endX = targetNode.y + graph.offsetX;
            const endY = targetNode.x + graph.offsetY;
            const cp1x = (startX + endX) / 2;
            const pathData = `M ${startX},${startY} C ${cp1x},${startY} ${cp1x},${endY} ${endX},${endY}`;
            this.drawBridgeLink_Legacy(pathData, cp1x, (startY + endY) / 2);
          }
        }
      }
      if (graph.extraConnectors) {
        graph.extraConnectors.forEach((extra) => {
          const startX = extra.originNode.y + graph.offsetX;
          const startY = extra.originNode.x + graph.offsetY;
          const endX = extra.targetNode.y + extra.targetGraph.offsetX;
          const endY = extra.targetNode.x + extra.targetGraph.offsetY;
          const cp1x = (startX + endX) / 2;
          const pathData = `M ${startX},${startY} C ${cp1x},${startY} ${cp1x},${endY} ${endX},${endY}`;
          this.drawBridgeLink_Legacy(pathData, cp1x, (startY + endY) / 2);
        });
      }
    });

    this.graphs.forEach((graph) => {
      const parentCounts = new Map<string, number>();
      const rawInputs = graph.inputRoot.data.inputs || [];
      rawInputs.forEach((input: any) => {
        if (input.children && Array.isArray(input.children)) {
          input.children.forEach((rm: any) => {
            const pid = rm.parent_tx_id;
            if (pid) parentCounts.set(pid, (parentCounts.get(pid) || 0) + 1);
          });
        }
      });

      [graph.inputRoot, graph.outputRoot].forEach((root) => {
        const links = root.links();
        const nodes = root.descendants();

        this.containerSelection
          .selectAll(`path.link-${graph.id}-${root.data.type}`)
          .data(links)
          .enter()
          .append('path')
          .attr('class', (d: any) => {
            let c = 'link';
            if (d.target.data.type === 'ring_member') c += ' ring-edge';
            if (
              d.source.data.type === 'tx' &&
              d.target.data.type === 'output' &&
              bridgeOutputs.has(d.target.data.id)
            )
              c += ' connected-path';
            return c;
          })
          .style('stroke', null)
          .style('stroke-width', null)
          .style('stroke-dasharray', (d: any) =>
            d.target.data.type === 'ring_member' ? '3, 3' : 'none',
          )
          .style('stroke-opacity', (d: any) => (d.target.data.type === 'ring_member' ? 0.3 : 1))
          .attr(
            'd',
            d3
              .linkHorizontal()
              .x((d: any) => d.y + graph.offsetX)
              .y((d: any) => d.x + graph.offsetY),
          );

        const nodeGroup = this.containerSelection
          .selectAll(`g.node-${graph.id}-${root.data.type}`)
          .data(nodes)
          .enter()
          .append('g')
          .attr('class', (d: any) => {
            let c = 'node';
            if (d.data.type === 'input') {
              c += ' node-input';
              if (d.children) c += ' expanded';
            }
            if (d.data.type === 'ring_member') c += ' node-ring';
            if (d.data.type === 'tx') c += ' node-tx';
            return c;
          })
          .attr('transform', (d: any) => `translate(${d.y + graph.offsetX},${d.x + graph.offsetY})`)
          .on('mouseover', (e: MouseEvent, d: any) => {
            if (d3.select(e.currentTarget as any).classed('faded')) return;
            let html = `<strong>${d.data.type.toUpperCase()}</strong>`;
            if (d.data.type === 'ring_member') {
              html += `<br>Hash: ${d.data.hash.substring(0, 8)}…${d.data.hash.slice(-8)}`;
              html += `<br>Block: ${d.data.block_height}`;
              html += `<br>Age: ${d.data.age_delta} blocks`;
              html += `<br>Global Decoy Count: ${d.data.decoy_count}`;
            } else if (d.data.type === 'tx') {
              html += `<br>Height: ${d.data.block_height || 'N/A'}`;
              html += `<br>Hash: ${d.data.id.substring(0, 8)}…${d.data.id.slice(-8)}`;
            } else if (d.data.type === 'output') {
              html += `<br>Stealth Address: ${d.data.stealth_address.substring(0, 8)}…${d.data.stealth_address.slice(-8)}`;
              html += `<br>Output Index: ${d.data.output_index}`;
            } else if (d.data.type === 'input') {
              html += `<br>Key Image: ${d.data.key_image.substring(0, 8)}…${d.data.key_image.slice(-8)}`;
              html += `<br>Ring Size: ${d.data.children.length}`;
            }
            this.showTooltip(e, html);
            if (d.data.type === 'ring_member')
              d3.select(e.currentTarget as any)
                .select('circle')
                .attr('stroke', '#fff')
                .attr('stroke-width', 2);
          })
          .on('mouseout', (e: MouseEvent, d: any) => {
            this.hideTooltip();
            const circle = d3.select(e.currentTarget as any).select('circle');
            const pid = d.data.parent_tx_id;
            const isDuplicate = pid && parentCounts.get(pid)! > 1;
            const isInHighlightSet = pid && this.clipboardService.allHighlightedHashes().has(pid);
            const isConnected = graph.expandedNodeIds.has(d.data.id);
            if (isConnected) {
              circle.attr('stroke', 'var(--graphSegmentExpanded, #59a14f)').attr('stroke-width', 1);
            } else if (isDuplicate && isInHighlightSet) {
              circle.attr('stroke', '#FF00FF').attr('stroke-width', 2);
            } else {
              circle.attr('stroke', 'none');
            }
          })
          .on('click', (e: MouseEvent, d: any) => this.handleNodeClick_Legacy(e, d, graph))
          .on('contextmenu', (e: MouseEvent, d: any) => this.handleNodeContextMenu(e, d));

        nodeGroup.each((d: any, i: any, nodes: any) => {
          const el = d3.select(nodes[i]);
          if (d.data.type === 'tx') {
            el.append('rect').attr('x', -50).attr('y', -10).attr('width', 100).attr('height', 20).attr('rx', 5);
            el.append('text')
              .attr('dy', 4)
              .attr('text-anchor', 'middle')
              .text(`Tx: ${d.data.id.substring(0, 4)}...${d.data.id.slice(-4)}`);

            const label = this.txLabels.get(d.data.id);
            if (label) {
              const labelGroup = el.append('g').attr('transform', 'translate(0, -27)');

              const maxLabelWidth = 400;
              let displayText = label.text;
              let estimatedWidth = Math.max(label.text.length * 6 + 10, 40);

              if (estimatedWidth > maxLabelWidth) {
                estimatedWidth = maxLabelWidth;
                const maxChars = Math.floor((maxLabelWidth - 20) / 6);
                displayText = label.text.substring(0, maxChars) + '...';
              }

              labelGroup
                .append('rect')
                .attr('class', 'label-rect')
                .attr('x', -estimatedWidth / 2)
                .attr('y', -10)
                .attr('width', estimatedWidth)
                .attr('height', 20)
                .style('fill', label.color)
                .attr('rx', 5);
              labelGroup
                .append('text')
                .attr('dy', 4)
                .attr('text-anchor', 'middle')
                .text(displayText)
                .style('fill', this.getContrastColor(label.color))
                .style('font-size', '10px')
                .style('font-weight', '500')
                .style('letter-spacing', '-0.3px')
                .style('font-family', 'Google Sans Code');

              labelGroup.on('mouseover', (e: MouseEvent) => e.stopPropagation());
            }
            el.style('cursor', 'pointer');
          } else if (d.data.type === 'ring_member') {
            const count = d.data.decoy_count || 0;
            const ratio = count / this.globalMaxDecoyCount;
            const radius = LEGACY_MIN_RADIUS + ratio * (LEGACY_MAX_RADIUS - LEGACY_MIN_RADIUS);

            const isConnected = graph.expandedNodeIds.has(d.data.id);
            const age = d.data.age_delta;
            const pid = d.data.parent_tx_id;
            const isDuplicate = pid && parentCounts.get(pid)! > 1;
            const isInHighlightSet = pid && this.clipboardService.allHighlightedHashes().has(pid);
            const isCoinbase = d.data.is_coinbase;
            const hash = d.data.hash;

            let fillColor = 'var(--graphSegmentDefault)';

            if (hash.startsWith('00000000')) {
              fillColor = 'var(--graphSegmentDanger)';
            } else if (isCoinbase) {
              fillColor = 'var(--graphSegmentCoinbase)';
            } else if (isDuplicate) {
              fillColor = 'var(--graphSegmentDuplicate)';
            } else if (isInHighlightSet) {
              fillColor = '#FF00FF';
            } else if (age <= 0) {
              fillColor = 'var(--graphSegmentAge0)';
            } else if (age <= 10) {
              fillColor = 'var(--graphSegmentAge1)';
            } else if (age <= 1440) {
              fillColor = 'var(--graphSegmentAge2)';
            } else if (age <= 21600) {
              fillColor = 'var(--graphSegmentAge3)';
            }

            let strokeColor = 'none';
            let strokeWidth = 0;

            if (isConnected) {
              strokeColor = 'var(--graphSegmentExpanded, #59a14f)';
              strokeWidth = 1;
            } else if (isDuplicate && isInHighlightSet) {
              strokeColor = '#FF00FF';
              strokeWidth = 1;
            }

            el.append('circle')
              .attr('r', radius)
              .attr('fill', fillColor)
              .attr('stroke', strokeColor)
              .attr('stroke-width', strokeWidth);
          } else if (d.data.type === 'output') {
            const isHighlighted = d.data.stealth_address === this.highlightedAddress;
            let isConnectedAsTarget = false;
            for (const g of this.graphs) {
              if (
                g.connector &&
                g.connector.targetNode &&
                g.connector.targetNode.data.stealth_address === d.data.stealth_address
              ) {
                isConnectedAsTarget = true;
                break;
              }
              if (
                g.extraConnectors &&
                g.extraConnectors.some(
                  (ec) => ec.targetNode.data.stealth_address === d.data.stealth_address,
                )
              ) {
                isConnectedAsTarget = true;
                break;
              }
            }
            let fillColor = 'steelblue';
            if (isConnectedAsTarget) fillColor = '#59a14f';
            else if (isHighlighted) fillColor = '#DF560A';
            el.append('path').attr('d', 'M -5,-5 L 5,0 L -5,5 Z').attr('fill', fillColor);
          } else if (d.data.type === 'input') {
            el.append('path').attr('d', 'M 0,-6 L 6,0 L 0,6 L -6,0 Z').attr('fill', '#00bcd4');
            el.style('cursor', 'default');
          }
        });
      });
    });
  }

  private drawBridgeLink_Legacy(pathData: string, midX: number, midY: number) {
    this.containerSelection
      .append('path')
      .attr('class', 'link bridge connected-path')
      .attr('d', pathData)
      .style('stroke', '#59a14f')
      .style('stroke-width', '2px')
      .style('fill', 'none')
      .style('opacity', '0.7');
  }

  private handleNodeClick_Legacy(event: MouseEvent, d: any, graph: GraphInstance): void {
    this.hideTooltip();
    event.stopPropagation();
    const type = d.data.type;
    if (type === 'tx') {
      event.preventDefault();
      const currentLabelData = this.txLabels.get(d.data.id) || { text: '', color: '#e04f5f' };

      this.modalService.open('edit-label', {
        txId: d.data.id,
        currentText: currentLabelData.text,
        currentColor: currentLabelData.color,
        onSave: (text: string, color: string) => {
          if (!text || text.trim() === '') {
            this.txLabels.delete(d.data.id);
          } else {
            this.txLabels.set(d.data.id, { text: text.trim(), color: color });
          }
          this.updateChart();
        },
      });
      return;
    }
    if (type === 'output') {
      this.navigateToDecoyMap(d.parent.data.id, d.data.stealth_address, d.data.output_index);
      return;
    }
    if (type === 'ring_member') {
      if (this.isGraphLoading()) return;
      const alreadyExpanded = graph.expandedNodeIds.has(d.data.id);
      if (alreadyExpanded) {
        this.removeDownstreamGraphs_Legacy([d.data.id]);
        this.updateChart_Legacy();
        return;
      }
      const parentId = d.data.parent_tx_id;
      if (!parentId) {
        alert('No parent TX data');
        return;
      }

      const existingGraph = this.graphs.find((g) => g.id === parentId);
      if (existingGraph) {
        const targetStealthAddress = d.data.hash;
        const matchNode: any = existingGraph.outputRoot
          .leaves()
          .find((node: any) => node.data.stealth_address === targetStealthAddress);
        if (matchNode) {
          if (!graph.extraConnectors) graph.extraConnectors = [];
          graph.extraConnectors.push({
            originNode: d,
            targetNode: matchNode,
            targetGraph: existingGraph,
          });
          graph.expandedNodeIds.add(d.data.id);
          this.updateChart_Legacy();
        } else {
          alert('Could not find matching output in the existing transaction graph.');
        }
        return;
      }

      graph.expandedNodeIds.add(d.data.id);
      const absolutePos = {
        absoluteX: d.y + graph.offsetX,
        absoluteY: d.x + graph.offsetY,
        graphCenterY: graph.offsetY,
        parentOffsetX: graph.offsetX,
        parent: d.parent,
        data: d.data,
        originGraphId: graph.id,
      };
      d3.select(event.currentTarget as any)
        .select('circle')
        .attr('fill', '#59a14f');
      this.isGraphLoading.set(true);
      this.transactionService.getTransaction(parentId).subscribe({
        next: (parentTxApi) => {
          const parentTx = this.mapApiToD3_Legacy(parentTxApi);
          if (parentTx) this.addTransactionToGraph_Legacy(parentTx, absolutePos);
          else {
            graph.expandedNodeIds.delete(d.data.id);
            this.updateChart_Legacy();
          }
          this.isGraphLoading.set(false);
        },
        error: (err) => {
          console.error('Failed to fetch parent transaction', err);
          graph.expandedNodeIds.delete(d.data.id);
          this.updateChart_Legacy();
          this.isGraphLoading.set(false);
        },
      });
    }
  }

  private removeDownstreamGraphs_Legacy(ringMemberIds: string[]): void {
    this.graphs.forEach((g) => {
      if (g.extraConnectors)
        g.extraConnectors = g.extraConnectors.filter(
          (ec) => !ringMemberIds.includes(ec.originNode.data.id),
        );
    });
    const graphsToRemove = this.graphs.filter(
      (g) => g.connector && ringMemberIds.includes(g.connector.originNodeId),
    );
    if (graphsToRemove.length === 0) return;
    graphsToRemove.forEach((g) => {
      const allNodes = g.inputRoot.descendants();
      const childRingMemberIds = allNodes
        .filter((n: any) => n.data.type === 'ring_member')
        .map((n: any) => n.data.id);
      this.removeDownstreamGraphs_Legacy(childRingMemberIds);
      const parentGraph = this.graphs.find((pg) =>
        pg.inputRoot.descendants().find((l: any) => l.data.id === g.connector!.originNodeId),
      );
      if (parentGraph && g.connector) parentGraph.expandedNodeIds.delete(g.connector.originNodeId);
    });
    const idsToRemove = new Set(graphsToRemove.map((g) => g.id));
    this.graphs = this.graphs.filter((g) => !idsToRemove.has(g.id));
  }

  private resolveCollisions_Legacy(): void {
    const iterations = 10;
    const padding = 60;
    const getBounds = (g: GraphInstance) => {
      let minY = Infinity,
        maxY = -Infinity,
        minX = Infinity,
        maxX = -Infinity;
      const update = (node: any) => {
        const absY = node.x + g.offsetY;
        const absX = node.y + g.offsetX;
        if (absY < minY) minY = absY;
        if (absY > maxY) maxY = absY;
        if (absX < minX) minX = absX;
        if (absX > maxX) maxX = absX;
      };
      g.inputRoot.descendants().forEach(update);
      g.outputRoot.descendants().forEach(update);
      return { minX, maxX, minY, maxY, id: g.id };
    };

    for (let k = 0; k < iterations; k++) {
      let hasCollision = false;
      const bounds = this.graphs.map((g) => ({ g, rect: getBounds(g) }));
      for (let i = 0; i < bounds.length; i++) {
        for (let j = i + 1; j < bounds.length; j++) {
          const b1 = bounds[i];
          const b2 = bounds[j];
          const xBuffer = 20;
          const noXOverlap =
            b1.rect.maxX < b2.rect.minX - xBuffer || b1.rect.minX > b2.rect.maxX + xBuffer;
          if (noXOverlap) continue;
          const noYOverlap =
            b1.rect.maxY < b2.rect.minY - padding || b1.rect.minY > b2.rect.maxY + padding;
          if (!noYOverlap) {
            hasCollision = true;
            const overlapHeight =
              Math.min(b1.rect.maxY, b2.rect.maxY) - Math.max(b1.rect.minY, b2.rect.minY) + padding;
            const c1 = (b1.rect.minY + b1.rect.maxY) / 2;
            const c2 = (b2.rect.minY + b2.rect.maxY) / 2;
            const shift = overlapHeight / 2;
            if (c1 < c2) {
              b1.g.offsetY -= shift;
              b2.g.offsetY += shift;
            } else {
              b2.g.offsetY -= shift;
              b1.g.offsetY += shift;
            }
          }
        }
      }
      if (!hasCollision) break;
    }
  }


  private handleNodeContextMenu(event: MouseEvent, d: any): void {
    if (d.data.type === 'tx') {
      event.preventDefault();
      this.hideTooltip();
      this.router.navigate(['/tx', d.data.id]);
    }
  }

  private hideTooltip(): void {
    if (this.tooltip && this.tooltip.nativeElement) {
      d3.select(this.tooltip.nativeElement).style('opacity', 0);
    }
  }

  private showTooltip(e: MouseEvent, html: string) {
    d3.select(this.tooltip.nativeElement)
      .style('opacity', 1)
      .html(html)
      .style('left', e.clientX + 10 + 'px')
      .style('top', e.clientY + 10 + 'px')
      .style('font-family', 'Google Sans Code');
  }

  private getOuterEdgePoint(
    centerX: number,
    centerY: number,
    startAngle: number,
    endAngle: number,
    radius: number,
  ) {
    const midAngle = (startAngle + endAngle) / 2;
    const localX = radius * Math.sin(midAngle);
    const localY = -radius * Math.cos(midAngle);
    return { x: centerX + localX, y: centerY + localY };
  }

  public visualizeTrace(result: MergingResult, colors?: string[]) {
    this.mergingResults = result;

    if (result && result.length > 0) {
      result.forEach((group, index) => {
        const labelText = index === 0 ? 'Initial Transaction' : `Consolidation ${index}`;

        let labelColor = index === 0 ? '#00bcd4' : '#faa459';

        if (colors && colors.length > index) {
          labelColor = colors[index];
        }

        group.forEach((tx) => {
          this.txLabels.set(tx.tx_hash, { text: labelText, color: labelColor });
        });
      });
    }

    if (this.currentMode() === 'ring') {
      this.visualizeTrace_Ring(result);
    } else {
      this.visualizeTrace_Legacy(result);
    }
  }

  private visualizeTrace_Ring(result: MergingResult) {
    this.clearChart();
    if (!result || result.length === 0) return;

    const lastRoundIndex = result.length - 1;
    const lastRoundTxs = result[lastRoundIndex];

    lastRoundTxs.forEach((tx) => {
      const mapped = this.mapApiToD3_Ring(tx);
      if (mapped) this.addTransactionToGraph_Ring(mapped, null, true, true);
    });

    const paddingY = 600;
    for (let i = 0; i < lastRoundTxs.length; i++) {
      const graph = this.graphs[i];
      if (graph) {
        graph.offsetY = i * paddingY;
      }
    }
    this.updateChart_Ring();

    for (let i = lastRoundIndex; i > 0; i--) {
      const currentRoundTxs = result[i];
      const previousRoundTxs = result[i - 1];

      const prevTxMap = new Map<string, Transaction>();
      previousRoundTxs.forEach((tx) => prevTxMap.set(tx.tx_hash, tx));

      const currentRoundGraphs = this.graphs.filter((g) =>
        currentRoundTxs.some((tx) => tx.tx_hash === g.id),
      );

      currentRoundGraphs.forEach((graph) => {
        const inputNodes = graph.inputRoot.leaves();

        inputNodes.forEach((inode: any) => {
          if (inode.data.arcs) {
            inode.data.arcs.forEach((arc: any) => {
              const rm = arc.data;
              const parentTxId = rm.parent_tx_id;

              if (prevTxMap.has(parentTxId)) {
                let parentGraph = this.graphs.find((g) => g.id === parentTxId);

                if (!parentGraph) {
                  const parentTx = prevTxMap.get(parentTxId)!;
                  const centerX = inode.y + graph.offsetX;
                  const centerY = inode.x + graph.offsetY;
                  const r = MAX_RADIUS + MAX_THICKNESS + OUTER_EDGE_BUFFER;
                  const anchor = this.getOuterEdgePoint(
                    centerX,
                    centerY,
                    arc.startAngle,
                    arc.endAngle,
                    r,
                  );
                  const angle = (arc.startAngle + arc.endAngle) / 2;

                  const alignTarget = {
                    absoluteX: anchor.x,
                    absoluteY: anchor.y,
                    centerX: centerX,
                    data: rm,
                    originGraphId: graph.id,
                    angle: angle,
                  };

                  graph.expandedNodeIds.add(rm.id);
                  const mappedParent = this.mapApiToD3_Ring(parentTx);
                  if (mappedParent) {
                    this.addTransactionToGraph_Ring(mappedParent, alignTarget, true, true);
                  }
                } else {
                  const targetStealthAddress = rm.hash;
                  const matchNode = parentGraph.outputRoot
                    .leaves()
                    .find((leaf: any) => leaf.data.stealth_address === targetStealthAddress);

                  if (matchNode) {
                    if (!graph.extraConnectors) graph.extraConnectors = [];
                    graph.extraConnectors.push({
                      originNodeData: rm,
                      targetNode: matchNode,
                      targetGraph: parentGraph,
                    });
                    graph.expandedNodeIds.add(rm.id);
                  }
                }
              }
            });
          }
        });
      });
      this.updateChart_Ring();
    }
  }

  private visualizeTrace_Legacy(result: MergingResult) {
    this.clearChart();
    if (!result || result.length === 0) return;

    const lastRoundIndex = result.length - 1;
    const lastRoundTxs = result[lastRoundIndex];

    lastRoundTxs.forEach((tx) => {
      const mapped = this.mapApiToD3_Legacy(tx);
      if (mapped) this.addTransactionToGraph_Legacy(mapped, null, true);
    });

    const paddingY = 600;
    for (let i = 0; i < lastRoundTxs.length; i++) {
      const graph = this.graphs[i];
      if (graph) {
        graph.offsetY = i * paddingY;
      }
    }
    this.updateChart_Legacy();

    for (let i = lastRoundIndex; i > 0; i--) {
      const currentRoundTxs = result[i];
      const previousRoundTxs = result[i - 1];
      const prevTxMap = new Map<string, Transaction>();
      previousRoundTxs.forEach((tx) => prevTxMap.set(tx.tx_hash, tx));

      const currentRoundGraphs = this.graphs.filter((g) =>
        currentRoundTxs.some((tx) => tx.tx_hash === g.id),
      );

      currentRoundGraphs.forEach((graph) => {
        const allNodes = graph.inputRoot.descendants();
        const ringMemberNodes = allNodes.filter((d: any) => d.data.type === 'ring_member');

        ringMemberNodes.forEach((rmNode: any) => {
          const rm = rmNode.data;
          const parentTxId = rm.parent_tx_id;

          if (prevTxMap.has(parentTxId)) {
            let parentGraph = this.graphs.find((g) => g.id === parentTxId);

            if (!parentGraph) {
              const parentTx = prevTxMap.get(parentTxId)!;

              const alignTarget = {
                absoluteX: rmNode.y + graph.offsetX,
                absoluteY: rmNode.x + graph.offsetY,
                graphCenterY: graph.offsetY,
                parentOffsetX: graph.offsetX,
                parent: rmNode.parent,
                data: rm,
                originGraphId: graph.id,
              };

              graph.expandedNodeIds.add(rm.id);
              const mappedParent = this.mapApiToD3_Legacy(parentTx);
              if (mappedParent) {
                this.addTransactionToGraph_Legacy(mappedParent, alignTarget, true);
              }
            } else {
              const targetStealthAddress = rm.hash;
              const matchNode = parentGraph.outputRoot
                .leaves()
                .find((leaf: any) => leaf.data.stealth_address === targetStealthAddress);

              if (matchNode) {
                if (!graph.extraConnectors) graph.extraConnectors = [];
                graph.extraConnectors.push({
                  originNode: rmNode,
                  targetNode: matchNode,
                  targetGraph: parentGraph,
                });
                graph.expandedNodeIds.add(rm.id);
              }
            }
          }
        });
      });
      this.updateChart_Legacy();
    }
  }

  public exportGraphConfiguration(): void {
    const graphSnapshots = this.graphs.map((g) => {
      let safeConnector = null;
      if (g.connector) {
        safeConnector = {
          originGraphId: g.connector.originGraphId,
          originNodeId: g.connector.originNodeId,
        };
      }

      const safeExtraConnectors = g.extraConnectors
        ?.filter((ec) => ec.targetGraph && ec.targetNode)
        .map((ec) => {
          const originId = ec.originNodeData?.id || ec.originNode?.data?.id;
          return {
            originNodeId: originId,
            targetNodeStealth: ec.targetNode.data.stealth_address,
            targetGraphId: ec.targetGraph.id,
          };
        });

      return {
        tx: g.inputRoot.data.raw,
        connector: safeConnector,
        extraConnectors: safeExtraConnectors,
        id: g.id,
        rotationEnabled: g.rotationEnabled,
        expandedNodeIds: Array.from(g.expandedNodeIds),
      };
    });

    const labelsObj: { [key: string]: { text: string; color: string } } = {};
    this.txLabels.forEach((val, key) => {
      labelsObj[key] = val;
    });

    const saveFile = {
      timestamp: new Date().toISOString(),
      mode: this.currentMode(),
      highlightedAddress: this.highlightedAddress,
      labels: labelsObj,
      graphs: graphSnapshots,
    };

    const jsonString = JSON.stringify(saveFile, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const element = document.createElement('a');
    element.href = url;
    element.download = `graph_export_${this.currentActiveHash}.json`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
    URL.revokeObjectURL(url);
  }

  public onImportFileSelected(event: any): void {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target?.result as string);
        this.restoreGraphFromSave(json);
      } catch (err) {
        console.error('Error parsing JSON:', err);
        alert('Invalid JSON file');
      }
      event.target.value = '';
    };
    reader.readAsText(file);
  }

  private restoreGraphFromSave(data: GraphSaveFile): void {
    this.clearChart();

    if (data.mode) {
      this.currentMode.set(data.mode);
      localStorage.setItem('txGraphMode', data.mode);
    }
    if (data.labels) {
      this.txLabels.clear();
      Object.entries(data.labels).forEach(([k, v]) => {
        if (typeof v === 'string') {
          this.txLabels.set(k, { text: v, color: '#e04f5f' });
        } else {
          this.txLabels.set(k, v);
        }
      });
    }
    if (data.highlightedAddress) {
      this.highlightedAddress = data.highlightedAddress;
    }

    const graphsToRestore = data.graphs;
    if (!graphsToRestore || graphsToRestore.length === 0) return;

    const rootInfo = graphsToRestore[0];
    const mappedRoot =
      this.currentMode() === 'ring'
        ? this.mapApiToD3_Ring(rootInfo.tx)
        : this.mapApiToD3_Legacy(rootInfo.tx);

    if (mappedRoot) {
      this.addTransactionToGraph(mappedRoot, null, false, rootInfo.rotationEnabled);

      const rootGraph = this.graphs.find((g) => g.id === rootInfo.id);
      if (rootGraph && rootInfo.expandedNodeIds) {
        rootInfo.expandedNodeIds.forEach((id) => rootGraph.expandedNodeIds.add(id));
      }
    }

    for (let i = 1; i < graphsToRestore.length; i++) {
      const gInfo = graphsToRestore[i];
      if (!gInfo.connector) continue;

      const parentId = gInfo.connector.originGraphId;
      const parentGraph = this.graphs.find((g) => g.id === parentId);

      if (parentGraph) {
        const originNodeId = gInfo.connector.originNodeId;
        const context = this.findRingMemberContext(parentGraph, originNodeId);

        if (context) {
          parentGraph.expandedNodeIds.add(originNodeId);

          if (this.currentMode() === 'ring') {
            this.prepareGraphData_Ring(parentGraph);
          }

          const alignTarget = this.generateAlignTarget(parentGraph, context);
          if (alignTarget) {
            const mappedTx =
              this.currentMode() === 'ring'
                ? this.mapApiToD3_Ring(gInfo.tx)
                : this.mapApiToD3_Legacy(gInfo.tx);

            if (mappedTx) {
              this.addTransactionToGraph(mappedTx, alignTarget, false, gInfo.rotationEnabled);

              const newGraph = this.graphs.find((g) => g.id === gInfo.id);
              if (newGraph && gInfo.expandedNodeIds) {
                gInfo.expandedNodeIds.forEach((id) => newGraph.expandedNodeIds.add(id));
              }
            }
          }
        }
      }
    }

    for (const gInfo of graphsToRestore) {
      if (gInfo.extraConnectors) {
        const currentGraph = this.graphs.find((g) => g.id === gInfo.id);
        if (!currentGraph) continue;

        if (!currentGraph.extraConnectors) currentGraph.extraConnectors = [];

        for (const ecSaved of gInfo.extraConnectors) {
          const targetGraph = this.graphs.find((g) => g.id === ecSaved.targetGraphId);
          if (targetGraph) {
            const context = this.findRingMemberContext(currentGraph, ecSaved.originNodeId);
            const targetNode = this.findOutputNodeByStealth(targetGraph, ecSaved.targetNodeStealth);

            if (context && targetNode) {
              currentGraph.extraConnectors.push({
                originNodeData: context.ringMemberData,
                originNode: context.d3Node, // For Legacy
                targetNode: targetNode,
                targetGraph: targetGraph,
              });
              currentGraph.expandedNodeIds.add(context.ringMemberData.id);
            }
          }
        }
      }
    }

    this.updateChart();
  }

  public navigateToDecoyMap(hash: string, key: string, index: number) {
    this.navigateToDecoy.emit();
    this.decoyService.openWithTxParams(hash, key, index);
  }

  public exportToGexf(): void {
    const nodes = new Map<string, { id: string; label: string; attributes: any }>();
    const edges: { source: string; target: string; type: string }[] = [];

    const addNode = (id: string, label: string, type: string, attributes: any = {}) => {
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          label,
          attributes: { ...attributes, type },
        });
      }
    };

    this.graphs.forEach((graph) => {
      const txId = graph.id;
      const tx = graph.inputRoot.data.raw as Transaction;
      if (!tx) return;

      addNode(txId, `Tx ${txId.substring(0, 8)}`, 'transaction', {
        block_height: tx.block_height,
        timestamp: tx.block_timestamp,
        version: tx.version,
        fee: tx.txnFee,
      });

      if (tx.outputs) {
        tx.outputs.forEach((out) => {
          const outId = out.stealth_address;
          addNode(outId, `Output ${outId.substring(0, 8)}`, 'output', {
            amount: out.amount,
            index: out.output_index,
          });
          edges.push({ source: txId, target: outId, type: 'created' });
        });
      }

      if (tx.inputs) {
        tx.inputs.forEach((input, inputIdx) => {
          const keyImageId = input.key_image || `input-${txId}-${inputIdx}`;
          addNode(keyImageId, `Input ${keyImageId.substring(0, 8)}`, 'input', {
            key_image: input.key_image,
          });
          edges.push({ source: keyImageId, target: txId, type: 'spent_in' });

          if (input.ring_members) {
            input.ring_members.forEach((rm) => {
              const rmId = rm.hash;
              addNode(rmId, `Output ${rmId.substring(0, 8)}`, 'output', {
                block_height: rm.block_height,
              });
              edges.push({ source: rmId, target: keyImageId, type: 'ring_member_of' });
            });
          }
        });
      }
    });

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<gexf xmlns="http://www.gexf.net/1.2draft" version="1.2">
  <graph mode="static" defaultedgetype="directed">
    <attributes class="node">
      <attribute id="type" title="Type" type="string"/>
      <attribute id="block_height" title="Block Height" type="integer"/>
      <attribute id="timestamp" title="Timestamp" type="long"/>
      <attribute id="fee" title="Fee" type="long"/>
      <attribute id="version" title="Version" type="integer"/>
      <attribute id="amount" title="Amount" type="long"/>
      <attribute id="index" title="Index" type="integer"/>
      <attribute id="key_image" title="Key Image" type="string"/>
    </attributes>
    <nodes>
`;

    nodes.forEach((node) => {
      xml += `      <node id="${node.id}" label="${node.label}">
        <attvalues>
          ${Object.entries(node.attributes)
          .map(([key, value]) =>
            value !== undefined ? `<attvalue for="${key}" value="${value}"/>` : '',
          )
          .join('\n          ')}
        </attvalues>
      </node>\n`;
    });

    xml += `    </nodes>
    <edges>
`;

    edges.forEach((edge, i) => {
      xml += `      <edge id="${i}" source="${edge.source}" target="${edge.target}" label="${edge.type}" />\n`;
    });

    xml += `    </edges>
  </graph>
</gexf>`;

    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const element = document.createElement('a');
    element.href = url;
    element.download = `monerovis_export_${this.currentActiveHash}.gexf`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
    URL.revokeObjectURL(url);
  }

  public exportToCsv(): void {
    const nodes = new Map<string, { id: string; label: string; type: string; attributes: any }>();
    const edges: { source: string; target: string; type: string }[] = [];

    const addNode = (id: string, label: string, type: string, attributes: any = {}) => {
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          label,
          type,
          attributes: { ...attributes },
        });
      }
    };

    this.graphs.forEach((graph) => {
      const txId = graph.id;
      const tx = graph.inputRoot.data.raw as Transaction;
      if (!tx) return;

      addNode(txId, `Tx ${txId.substring(0, 8)}`, 'transaction', {
        block_height: tx.block_height,
        timestamp: tx.block_timestamp,
        version: tx.version,
        fee: tx.txnFee,
      });

      if (tx.outputs) {
        tx.outputs.forEach((out) => {
          const outId = out.stealth_address;
          addNode(outId, `Output ${outId.substring(0, 8)}`, 'output', {
            amount: out.amount,
            index: out.output_index,
          });
          edges.push({ source: txId, target: outId, type: 'created' });
        });
      }

      if (tx.inputs) {
        tx.inputs.forEach((input, inputIdx) => {
          const keyImageId = input.key_image || `input-${txId}-${inputIdx}`;
          addNode(keyImageId, `Input ${keyImageId.substring(0, 8)}`, 'input', {
            key_image: input.key_image,
          });
          edges.push({ source: keyImageId, target: txId, type: 'spent_in' });

          if (input.ring_members) {
            input.ring_members.forEach((rm) => {
              const rmId = rm.hash;
              addNode(rmId, `Output ${rmId.substring(0, 8)}`, 'output', {
                block_height: rm.block_height,
              });
              edges.push({ source: rmId, target: keyImageId, type: 'ring_member_of' });
            });
          }
        });
      }
    });

    const header = [
      'Id',
      'Label',
      'Type',
      'BlockHeight',
      'Timestamp',
      'Version',
      'Fee',
      'Amount',
      'Index',
      'KeyImage',
    ].join(',');

    const csvRows = [header];
    nodes.forEach((node) => {
      const row = [
        node.id,
        node.label,
        node.type,
        node.attributes.block_height || '',
        node.attributes.timestamp || '',
        node.attributes.version || '',
        node.attributes.fee || '',
        node.attributes.amount || '',
        node.attributes.index || '',
        node.attributes.key_image || '',
      ].map(val => `"${val}"`).join(',');
      csvRows.push(row);
    });

    const nodesCsv = csvRows.join('\n');
    this.downloadFile(nodesCsv, `monerovis_nodes_${this.currentActiveHash}.csv`, 'csv');

    const edgesHeader = ['Source', 'Target', 'Type'].join(',');
    const edgesRows = [edgesHeader];
    edges.forEach((edge) => {
      edgesRows.push(`"${edge.source}","${edge.target}","${edge.type}"`);
    });

    const edgesCsv = edgesRows.join('\n');
    setTimeout(() => {
      this.downloadFile(edgesCsv, `monerovis_edges_${this.currentActiveHash}.csv`, 'csv');
    }, 500);
  }

  private downloadFile(content: string, filename: string, type: string) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const element = document.createElement('a');
    element.href = url;
    element.download = filename;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
    URL.revokeObjectURL(url);
  }

  public openExportModal(): void {
    this.modalService.open('export-format', {
      onSelect: (format: 'gexf' | 'csv' | 'json') => {
        if (format === 'gexf') this.exportToGexf();
        else if (format === 'csv') this.exportToCsv();
        else if (format === 'json') this.exportGraphConfiguration();
      }
    });
  }

  ngOnDestroy(): void {
    if (!this.fillParent && this.isFullscreen()) {
      this.sidebarService.isAnyGraphFullscreen.set(false);
    }
    this.clearChart();
  }
}
