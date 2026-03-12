export interface HomeBlock {
  height: number;
  txCount: number;
  hash: string;
  reward: number;
  relativeTime: string;
  timestamp: number;
  isNew?: boolean;
}

export interface HomeMempoolTx {
  hash: string;
  size: number;
  fee: number;
  inputs: number;
  outputs: number;
  isNew?: boolean;
}

export interface HomeData {
  blocks: HomeBlock[];
  mempool: HomeMempoolTx[];
  blockWeightLimit: number;
}
