import { Block } from './block';
import { Transaction } from './transaction';

export type SearchResult = Block | Transaction;

export function isBlock(data: SearchResult): data is Block {
  return (data as Block).height !== undefined;
}

export function isTransaction(data: SearchResult): data is Transaction {
  return (data as Transaction).tx_hash !== undefined;
}
