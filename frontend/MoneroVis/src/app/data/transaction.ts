export interface MinimalTransaction {
  hash: string;
  size: number;
  fee: number;
  in: number;
  out: number;
}

export interface MinerTransaction {
  hash: string;
  size: number;
  outputs: number;
}

export interface RingMember {
  hash: string;
  block_height: number;
  parent_transaction: string;
  decoy_count: number;
  is_coinbase?: boolean;
}

export interface TxInput {
  key_image: string;
  ring_members: RingMember[];
  amount?: number;
}

export interface TxOutput {
  stealth_address: string;
  view_tag?: string;
  output_index: number;
  amount?: number;
}

export interface Transaction {
  block_height: number;
  block_timestamp: number;
  relative_time: string;
  confirmations: number;
  version: number;
  output_indices: number[];
  inputs: TxInput[];
  outputs: TxOutput[];
  tx_hash: string;
  extra: string;
  type: number;
  txnFee: number;
  as_json: string;
  size: number;
}

export interface TransactionJson {
  [key: string]: any;
}
