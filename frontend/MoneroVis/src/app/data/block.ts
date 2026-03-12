import { MinerTransaction, MinimalTransaction } from './transaction';

export interface Block {
  height: number;
  hash: string;
  timestamp: string;
  relativeTime: string;
  blockSize: number;
  depth: number;
  nonce: number;
  minerTx: MinerTransaction;
  transactions: MinimalTransaction[] | null;
  totalFees: number;
  minFee: number;
  maxFee: number;
  status: string;
}

export interface BlockListEntry {
  height: number;
  hash: string;
  timestamp: string;
  timestampRaw: number;
  relativeTime: string;
  size: number;
  txCount: number;
  reward: number;
}

export interface BlocksResponse {
  blocks: BlockListEntry[];
  page: number;
  totalPages: number;
  totalBlocks: number;
}
